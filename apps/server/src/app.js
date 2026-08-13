import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { normalizeName } from "../../../packages/shared/src/constants.js";
import {
  castVote,
  cleanupExpiredRooms,
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
  const allow = createRateLimiter({ maxKeys: 10_000 });
  const roundTimers = new Map();
  const voteTimeoutSeconds = config.voteTimeoutSeconds || 45;
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const expireRooms = () => {
    for (const roomId of cleanupExpiredRooms(database)) eventHub.expireRoom(roomId);
    eventHub.pruneInvalidRooms();
  };
  expireRooms();
  const cleanupTimer = setInterval(expireRooms, 60_000);
  cleanupTimer.unref?.();
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
    setSecurityHeaders(response, config.secureCookies);
    try {
      const url = new URL(request.url, config.publicUrl);
      const ip = clientIp(request, config);
      if (
        request.method === "POST" &&
        request.headers.origin &&
        request.headers.origin !== new URL(config.publicUrl).origin
      ) return json(response, 403, { error: "Cross-origin requests are not allowed." });

      if (request.method === "GET" && url.pathname === "/api/config") {
        return json(response, 200, {
          turnstileSiteKey: config.turnstileSiteKey,
          turnstileBypass: config.turnstileBypass,
          cliCommand: config.cliCommand
        });
      }

      if (request.method === "POST" && url.pathname === "/api/rooms") {
        if (
          !allow("global:create", 300, 60_000) ||
          !allow(`create:${ip}`, 5, 60 * 60 * 1000)
        ) return json(response, 429, { error: "Too many rooms created. Try again later." });
        const body = await readJson(request);
        const valid = await verifyTurnstile(body.turnstileToken, "create_room", ip, config, fetchImpl);
        if (!valid) return json(response, 400, { error: "Verification failed. Please try again." });
        const room = createRoom(database);
        const joinUrl = `${config.publicUrl}/room/${room.publicId}#join=${room.joinToken}`;
        return json(response, 201, { roomId: room.publicId, joinUrl, expiresAt: room.expiresAt });
      }

      const joinMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{12})\/join$/);
      if (request.method === "POST" && joinMatch) {
        const roomId = joinMatch[1];
        if (
          !allow("global:join", 1_000, 60_000) ||
          !allow(`join:${ip}`, 20, 10 * 60 * 1000) ||
          !allow(`room:${roomId}`, 60, 10 * 60 * 1000)
        ) {
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

      const importTokenMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{12})\/import-token$/);
      if (request.method === "POST" && importTokenMatch) {
        const roomId = importTokenMatch[1];
        if (
          !allow("global:import-token", 300, 60_000) ||
          !allow(`import-token:${ip}`, 10, 60_000)
        ) return json(response, 429, { error: "Too many import codes requested. Try again later." });
        await readJson(request);
        const issued = issueImportToken(database, roomId, cookie(request, sessionCookieName(roomId)));
        if (issued.error) return json(response, 401, { error: "Join this room to import prompts." });
        const roomUrl = `${config.publicUrl}/room/${roomId}`;
        return json(response, 201, {
          command: `${config.cliCommand} import --room ${roomUrl}`,
          token: issued.token,
          expiresAt: issued.expiresAt,
          name: issued.name
        });
      }

      const promptsMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{12})\/prompts$/);
      if (request.method === "POST" && promptsMatch) {
        const roomId = promptsMatch[1];
        if (
          !allow("global:import", 600, 60_000) ||
          !allow(`import:${ip}`, 20, 10 * 60 * 1000)
        ) return json(response, 429, { error: "Too many imports. Try again later." });
        const body = await readJson(request);
        const imported = importPrompts(database, roomId, bearerToken(request), body.prompts);
        if (imported.error === "UNAUTHORIZED") return json(response, 401, { error: "This import token is invalid or expired." });
        if (imported.error) return json(response, 400, { error: "Choose between 1 and 5 short prompts." });
        eventHub.publish(roomId);
        return json(response, 201, imported);
      }

      const roundMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{12})\/(start|next)$/);
      if (request.method === "POST" && roundMatch) {
        const roomId = roundMatch[1];
        if (
          !allow("global:game-action", 2_000, 60_000) ||
          !allow(`game-action:${ip}`, 120, 60_000)
        ) return json(response, 429, { error: "Too many game actions. Try again later." });
        await readJson(request);
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

      const voteMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{12})\/vote$/);
      if (request.method === "POST" && voteMatch) {
        const roomId = voteMatch[1];
        if (
          !allow("global:vote", 2_000, 60_000) ||
          !allow(`vote:${ip}`, 120, 60_000)
        ) return json(response, 429, { error: "Too many votes. Try again later." });
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

      const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{12})$/);
      if (request.method === "GET" && roomMatch) {
        if (
          !allow("global:room-state", 5_000, 60_000) ||
          !allow(`room-state:${ip}`, 600, 60_000)
        ) return json(response, 429, { error: "Too many room requests. Try again later." });
        const room = getRoomForSession(database, roomMatch[1], cookie(request, sessionCookieName(roomMatch[1])));
        if (!room) return json(response, 401, { error: "Join this room to continue." });
        return json(response, 200, room);
      }

      if (request.method === "GET") return serveFrontend(url.pathname, response, config);
      return json(response, 404, { error: "Not found." });
    } catch (error) {
      if (error.code === "INVALID_JSON") return json(response, 400, { error: "Invalid request body." });
      if (error.code === "UNSUPPORTED_MEDIA_TYPE") {
        return json(response, 415, { error: "Requests must use application/json." });
      }
      console.error(error);
      return json(response, 500, { error: "Something went wrong." });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url, config.publicUrl);
      const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{12})\/socket$/);
      if (!match) return rejectUpgrade(socket, 404, "Not Found");
      if (request.headers.origin && request.headers.origin !== new URL(config.publicUrl).origin) {
        return rejectUpgrade(socket, 403, "Forbidden");
      }

      const roomId = match[1];
      const ip = clientIp(request, config);
      if (
        !allow("global:socket", 1_000, 60_000) ||
        !allow(`socket:${ip}`, 50, 60_000)
      ) return rejectUpgrade(socket, 429, "Too Many Requests");
      const sessionToken = cookie(request, sessionCookieName(roomId));
      const room = getRoomForSession(database, roomId, sessionToken);
      if (!room) return rejectUpgrade(socket, 401, "Unauthorized");

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.once("message", () => webSocket.close(1008, "read_only"));
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
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on("close", () => {
    clearInterval(cleanupTimer);
    for (const timer of roundTimers.values()) clearTimeout(timer);
    roundTimers.clear();
  });
  return server;
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
    const error = new Error("unsupported content type");
    error.code = "UNSUPPORTED_MEDIA_TYPE";
    throw error;
  }
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

async function serveFrontend(pathname, response, config) {
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
  const legalRoutes = {
    "/imprint": "imprint.html",
    "/impressum": "imprint.html",
    "/privacy": "privacy.html",
    "/datenschutz": "privacy.html"
  };
  const requested = legalRoutes[pathname] || (pathname === "/" || pathname.startsWith("/room/")
    ? "index.html"
    : normalize(pathname).replace(/^[/\\]+/, ""));
  if (requested.includes("..")) return json(response, 404, { error: "Not found." });
  try {
    let body = await readFile(join(webRoot, requested));
    if (requested === "imprint.html" || requested === "privacy.html") {
      body = renderLegalDocument(body.toString("utf8"), config.legal);
    }
    response.writeHead(200, {
      "content-type": mimeTypes[extname(requested)] || "application/octet-stream",
      ...(requested.endsWith(".html") ? { "cache-control": "no-cache" } : {})
    });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not found." });
  }
}

function renderLegalDocument(document, legal = {}) {
  const name = legal.name || "Operator details not configured";
  const address = legal.address || "Set LEGAL_ADDRESS before publishing";
  const email = legal.email || "legal@example.invalid";
  const representativeBlock = legal.representative
    ? `<p>Represented by: ${escapeHtml(legal.representative)}</p>`
    : "";
  const registerBlock = legal.register && legal.registrationNumber
    ? `<section class="legal-section"><h2>Register</h2><p>${escapeHtml(legal.register)} · Registration number ${escapeHtml(legal.registrationNumber)}</p></section>`
    : "";

  return document
    .replaceAll("{{LEGAL_NAME}}", escapeHtml(name))
    .replaceAll("{{LEGAL_ADDRESS}}", escapeHtml(address))
    .replaceAll("{{LEGAL_EMAIL}}", escapeHtml(email))
    .replaceAll("{{LEGAL_EMAIL_URL}}", escapeHtml(`mailto:${email}`))
    .replaceAll("{{LEGAL_REPRESENTATIVE_BLOCK}}", representativeBlock)
    .replaceAll("{{LEGAL_REGISTER_BLOCK}}", registerBlock);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function clientIp(request, config) {
  const remoteAddress = normalizeIp(request.socket.remoteAddress) || "unknown";
  if (!config.trustProxy || !config.trustedProxyAddresses?.includes(remoteAddress)) {
    return remoteAddress;
  }
  const forwarded = String(request.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => normalizeIp(value.trim()));
  if (forwarded.length === 0 || forwarded.some((value) => !value)) return remoteAddress;

  const chain = [...forwarded, remoteAddress];
  let index = chain.length - 1;
  while (index > 0 && config.trustedProxyAddresses.includes(chain[index])) index -= 1;
  return chain[index];
}

function normalizeIp(value) {
  if (typeof value !== "string") return null;
  const normalized = value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  return isIP(normalized) ? normalized : null;
}

function setSecurityHeaders(response, secure) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("permissions-policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; connect-src 'self'; img-src 'self' data:");
  if (secure) response.setHeader("strict-transport-security", "max-age=31536000");
}
