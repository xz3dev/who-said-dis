import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { normalizeName } from "../../../packages/shared/src/constants.js";
import {
  castVote,
  createRoom,
  getRoomForSession,
  importPrompts,
  issueImportToken,
  joinRoom,
  listVotingRounds,
  revealExpiredRound,
  startNextRound
} from "./database.js";
import { createRateLimiter } from "./rate-limit.js";
import { RoomEventHub } from "./room-events.js";
import { verifyTurnstile } from "./turnstile.js";

const webRoot = fileURLToPath(new URL("../../web/", import.meta.url));
const reconnectingWebSocketPath = fileURLToPath(
  new URL("../../../node_modules/reconnecting-websocket/dist/reconnecting-websocket-mjs.js", import.meta.url)
);
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };

export function createApp({ database, config, fetchImpl = fetch, eventHub = new RoomEventHub() }) {
  const allow = createRateLimiter();
  const roundTimers = new Map();
  const voteTimeoutSeconds = config.voteTimeoutSeconds || 45;
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const scheduleReveal = (roomId, deadline) => {
    clearTimeout(roundTimers.get(roomId));
    const timer = setTimeout(() => {
      roundTimers.delete(roomId);
      if (revealExpiredRound(database, roomId)) eventHub.publish(roomId);
      else if (Date.now() < deadline) scheduleReveal(roomId, deadline);
    }, Math.max(1, deadline - Date.now() + 1));
    timer.unref?.();
    roundTimers.set(roomId, timer);
  };
  for (const round of listVotingRounds(database)) scheduleReveal(round.roomId, round.deadline);
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url, config.publicUrl);
      const ip = clientIp(request, config.trustProxy);

      if (request.method === "GET" && url.pathname === "/api/config") {
        return json(response, 200, {
          turnstileSiteKey: config.turnstileSiteKey,
          turnstileBypass: config.turnstileBypass,
          cliCommand: config.cliCommand
        });
      }

      if (request.method === "POST" && url.pathname === "/api/rooms") {
        if (!allow(`create:${ip}`, 5, 60 * 60 * 1000)) return json(response, 429, { error: "Too many rooms created. Try again later." });
        const body = await readJson(request);
        const valid = await verifyTurnstile(body.turnstileToken, "create_room", ip, config, fetchImpl);
        if (!valid) return json(response, 400, { error: "Verification failed. Please try again." });
        const room = createRoom(database);
        const joinUrl = `${config.publicUrl}/room/${room.publicId}#join=${room.joinToken}`;
        return json(response, 201, { roomId: room.publicId, joinUrl, expiresAt: room.expiresAt });
      }

      const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/join$/);
      if (request.method === "POST" && joinMatch) {
        const roomId = joinMatch[1];
        if (!allow(`join:${ip}`, 20, 10 * 60 * 1000) || !allow(`room:${roomId}`, 60, 10 * 60 * 1000)) {
          return json(response, 429, { error: "Too many join attempts. Try again later." });
        }
        const body = await readJson(request);
        const name = normalizeName(body.name);
        if (!name) return json(response, 400, { error: "Enter a name between 1 and 32 characters." });
        const valid = await verifyTurnstile(body.turnstileToken, "join_room", ip, config, fetchImpl);
        if (!valid) return json(response, 400, { error: "Verification failed. Please try again." });
        const joined = joinRoom(database, roomId, body.joinToken, name);
        if (joined.error === "NAME_TAKEN") return json(response, 409, { error: "That name is already in this room." });
        if (joined.error === "ROOM_FULL") return json(response, 409, { error: "This room is full." });
        if (joined.error) return json(response, 404, { error: "Room not found or invite expired." });
        setSessionCookie(response, roomId, joined.sessionToken, config.secureCookies);
        return json(response, 201, { participantId: joined.participantId });
      }

      const importTokenMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/import-token$/);
      if (request.method === "POST" && importTokenMatch) {
        const roomId = importTokenMatch[1];
        const issued = issueImportToken(database, roomId, cookie(request, sessionCookieName(roomId)));
        if (issued.error) return json(response, 401, { error: "Join this room to import prompts." });
        const roomUrl = `${config.publicUrl}/room/${roomId}`;
        return json(response, 201, {
          command: `${config.cliCommand} import --room ${roomUrl} --token ${issued.token}`,
          name: issued.name
        });
      }

      const promptsMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/prompts$/);
      if (request.method === "POST" && promptsMatch) {
        const roomId = promptsMatch[1];
        if (!allow(`import:${ip}`, 20, 10 * 60 * 1000)) return json(response, 429, { error: "Too many imports. Try again later." });
        const body = await readJson(request);
        const imported = importPrompts(database, roomId, bearerToken(request), body.prompts);
        if (imported.error === "UNAUTHORIZED") return json(response, 401, { error: "This import token is invalid or expired." });
        if (imported.error) return json(response, 400, { error: "Choose between 1 and 5 short prompts." });
        eventHub.publish(roomId);
        return json(response, 201, imported);
      }

      const roundMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/(start|next)$/);
      if (request.method === "POST" && roundMatch) {
        const roomId = roundMatch[1];
        const result = startNextRound(
          database,
          roomId,
          cookie(request, sessionCookieName(roomId)),
          voteTimeoutSeconds
        );
        if (result.error === "UNAUTHORIZED") return json(response, 401, { error: "Join this room to continue." });
        if (result.error) return json(response, 409, { error: "The game has already moved on." });
        if (result.deadline) scheduleReveal(roomId, result.deadline);
        else clearTimeout(roundTimers.get(roomId));
        eventHub.publish(roomId);
        return json(response, 200, result);
      }

      const voteMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/vote$/);
      if (request.method === "POST" && voteMatch) {
        const roomId = voteMatch[1];
        const body = await readJson(request);
        const result = castVote(
          database,
          roomId,
          cookie(request, sessionCookieName(roomId)),
          Number(body.participantId)
        );
        if (result.error === "UNAUTHORIZED") return json(response, 401, { error: "Join this room to vote." });
        if (result.error === "ALREADY_VOTED") return json(response, 409, { error: "Your vote is already locked in." });
        if (result.error) return json(response, 409, { error: "Voting has closed or that answer is unavailable." });
        if (result.revealed) {
          clearTimeout(roundTimers.get(roomId));
          roundTimers.delete(roomId);
        }
        eventHub.publish(roomId);
        return json(response, 201, result);
      }

      const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && roomMatch) {
        const room = getRoomForSession(database, roomMatch[1], cookie(request, sessionCookieName(roomMatch[1])));
        if (!room) return json(response, 401, { error: "Join this room to continue." });
        return json(response, 200, room);
      }

      if (request.method === "GET") return serveFrontend(url.pathname, response);
      return json(response, 404, { error: "Not found." });
    } catch (error) {
      if (error.code === "INVALID_JSON") return json(response, 400, { error: "Invalid request body." });
      console.error(error);
      return json(response, 500, { error: "Something went wrong." });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url, config.publicUrl);
      const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/socket$/);
      if (!match) return rejectUpgrade(socket, 404, "Not Found");
      if (request.headers.origin && request.headers.origin !== new URL(config.publicUrl).origin) {
        return rejectUpgrade(socket, 403, "Forbidden");
      }

      const roomId = match[1];
      const sessionToken = cookie(request, sessionCookieName(roomId));
      const room = getRoomForSession(database, roomId, sessionToken);
      if (!room) return rejectUpgrade(socket, 401, "Unauthorized");
      const ip = clientIp(request, config.trustProxy);

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const subscribed = eventHub.subscribe(
          roomId,
          room.you.id,
          ip,
          webSocket,
          () => getRoomForSession(database, roomId, sessionToken)
        );
        if (!subscribed) webSocket.close(1008, "connection_limit");
      });
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
    }
  });
  server.roomEvents = eventHub;
  server.webSocketServer = webSocketServer;
  server.on("close", () => {
    for (const timer of roundTimers.values()) clearTimeout(timer);
    roundTimers.clear();
  });
  return server;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) {
      const error = new Error("body too large");
      error.code = "INVALID_JSON";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("invalid json");
    error.code = "INVALID_JSON";
    throw error;
  }
}

async function serveFrontend(pathname, response) {
  if (pathname === "/vendor/reconnecting-websocket.js") {
    try {
      const body = await readFile(reconnectingWebSocketPath);
      response.writeHead(200, { "content-type": mimeTypes[".js"], "cache-control": "public, max-age=86400" });
      response.end(body);
    } catch {
      json(response, 404, { error: "Not found." });
    }
    return;
  }
  const requested = pathname === "/" || pathname.startsWith("/room/") ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
  if (requested.includes("..")) return json(response, 404, { error: "Not found." });
  try {
    const body = await readFile(join(webRoot, requested));
    response.writeHead(200, { "content-type": mimeTypes[extname(requested)] || "application/octet-stream" });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not found." });
  }
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function setSessionCookie(response, roomId, token, secure) {
  response.setHeader("set-cookie", `${sessionCookieName(roomId)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? "; Secure" : ""}`);
}

function sessionCookieName(roomId) { return `wsd_session_${roomId}`; }

function cookie(request, name) {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function bearerToken(request) {
  const match = String(request.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]+)$/);
  return match?.[1] || null;
}

function clientIp(request, trustProxy) {
  if (trustProxy) return String(request.headers["x-forwarded-for"] || "").split(",")[0].trim() || request.socket.remoteAddress || "unknown";
  return request.socket.remoteAddress || "unknown";
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; connect-src 'self'; img-src 'self' data:");
}
