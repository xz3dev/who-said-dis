import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createApp } from "../apps/server/src/app.js";
import { readConfig } from "../apps/server/src/config.js";
import {
  calculateVotePoints,
  castVote,
  createRoom,
  getRoomForSession,
  importPrompts,
  issueImportToken,
  joinRoom,
  openDatabase,
  startNextRound
} from "../apps/server/src/database.js";
import { RoomEventHub } from "../apps/server/src/room-events.js";
import { verifyTurnstile } from "../apps/server/src/turnstile.js";

test("advertises the local or published CLI command for the current environment", () => {
  const development = readConfig({ TURNSTILE_BYPASS: "1" });
  const production = readConfig({
    NODE_ENV: "production",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET: "secret"
  });
  const overridden = readConfig({ TURNSTILE_BYPASS: "1", CLI_COMMAND: "custom-cli --dev" });
  const timed = readConfig({ TURNSTILE_BYPASS: "1", VOTE_TIMEOUT_SECONDS: "12" });

  assert.equal(development.cliCommand, "npm run cli --");
  assert.equal(production.cliCommand, "npx @xz3dev/who-said-dis");
  assert.equal(overridden.cliCommand, "custom-cli --dev");
  assert.equal(development.voteTimeoutSeconds, 45);
  assert.equal(timed.voteTimeoutSeconds, 12);
  assert.throws(() => readConfig({ TURNSTILE_BYPASS: "1", VOTE_TIMEOUT_SECONDS: "0" }), /VOTE_TIMEOUT_SECONDS/);
});

test("imports prompts under a participant and runs voting through reveal and finish", () => {
  const database = openDatabase(":memory:");
  const now = 1_700_000_000_000;
  const room = createRoom(database, now);
  const players = ["Ada", "Grace", "Linus", "Margaret", "Ken"].map((name, index) => ({
    name,
    ...joinRoom(database, room.publicId, room.joinToken, name, now + index + 1)
  }));
  const token = issueImportToken(database, room.publicId, players[0].sessionToken, now + 10);
  assert.equal(importPrompts(database, room.publicId, token.token, [
    { text: "why is the compiler emotionally unavailable?", citation: "codex://test/1" }
  ], now + 11).imported, 1);

  const started = startNextRound(database, room.publicId, players[1].sessionToken, 45, now + 12);
  assert.equal(started.phase, "voting");
  const voting = getRoomForSession(database, room.publicId, players[1].sessionToken, now + 13);
  assert.equal(voting.game.phase, "voting");
  assert.equal(voting.game.options.length, 4);
  assert.ok(voting.game.options.some((option) => option.id === players[0].participantId));
  assert.equal("correctParticipantId" in voting.game, false);

  for (let index = 0; index < players.length; index += 1) {
    const vote = castVote(
      database,
      room.publicId,
      players[index].sessionToken,
      players[0].participantId,
      now + 20 + index
    );
    assert.equal(vote.accepted, true);
  }
  const revealed = getRoomForSession(database, room.publicId, players[1].sessionToken, now + 30);
  assert.equal(revealed.game.phase, "reveal");
  assert.equal(revealed.game.correctParticipantId, players[0].participantId);
  assert.ok(revealed.game.results.every((result) => result.correct));
  assert.ok(revealed.game.results.every((result) => result.points === 200));
  assert.equal(revealed.you.score, 200);

  assert.equal(startNextRound(database, room.publicId, players[0].sessionToken, 45, now + 31).phase, "finished");
  const finished = getRoomForSession(database, room.publicId, players[0].sessionToken, now + 32).game;
  assert.equal(finished.phase, "finished");
  assert.equal(finished.recap.length, 1);
  assert.equal(finished.recap[0].round, 1);
  assert.equal(finished.recap[0].prompt, "why is the compiler emotionally unavailable?");
  assert.equal(finished.recap[0].author.name, "Ada");
  assert.equal(finished.recap[0].options.length, 4);
  assert.ok(finished.recap[0].options.some((option) => option.id === players[0].participantId));
  assert.ok(finished.recap[0].results.every((result) => result.correct));
  database.close();
});

test("scores correct votes from 100 to 200 points based on response time", () => {
  assert.equal(calculateVotePoints(1_000, 11_000, 1_000), 200);
  assert.equal(calculateVotePoints(1_000, 11_000, 6_000), 150);
  assert.equal(calculateVotePoints(1_000, 11_000, 10_999), 100);
  assert.equal(calculateVotePoints(1_000, 11_000, 20_000), 100);
});

test("reveals a round after its configured deadline", () => {
  const database = openDatabase(":memory:");
  const now = 1_700_000_000_000;
  const room = createRoom(database, now);
  const joined = joinRoom(database, room.publicId, room.joinToken, "Ada", now + 1);
  const token = issueImportToken(database, room.publicId, joined.sessionToken, now + 2);
  importPrompts(database, room.publicId, token.token, [{ text: "timed prompt" }], now + 3);
  startNextRound(database, room.publicId, joined.sessionToken, 12, now + 4);

  const revealed = getRoomForSession(database, room.publicId, joined.sessionToken, now + 12_005);
  assert.equal(revealed.game.phase, "reveal");
  assert.equal(revealed.game.results[0].guessParticipantId, null);
  assert.equal(revealed.game.results[0].points, 0);
  assert.equal(revealed.you.score, 0);
  database.close();
});

test("room creation is empty until someone joins with its private token", () => {
  const database = openDatabase(":memory:");
  const room = createRoom(database, 1_700_000_000_000);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM participants").get().count, 0);
  assert.deepEqual(joinRoom(database, room.publicId, "wrong-token-that-is-definitely-long", "Ada", 1_700_000_000_001), { error: "ROOM_NOT_FOUND" });

  const joined = joinRoom(database, room.publicId, room.joinToken, "Ada", 1_700_000_000_001);
  assert.ok(joined.sessionToken);
  const state = getRoomForSession(database, room.publicId, joined.sessionToken, 1_700_000_000_002);
  assert.equal(state.participants.length, 1);
  assert.equal(state.you.name, "Ada");
  assert.equal(joinRoom(database, room.publicId, room.joinToken, "ada", 1_700_000_000_003).error, "NAME_TAKEN");
  database.close();
});

test("Turnstile requires matching success, action, and hostname", async () => {
  const config = { turnstileSecretKey: "secret", turnstileHostname: "who-said-dis.com" };
  const fetchImpl = async () => ({
    json: async () => ({ success: true, action: "create_room", hostname: "who-said-dis.com" })
  });
  assert.equal(await verifyTurnstile("token", "create_room", "127.0.0.1", config, fetchImpl), true);
  assert.equal(await verifyTurnstile("token", "join_room", "127.0.0.1", config, fetchImpl), false);
});

test("HTTP flow creates an empty room and joins it through the returned URL", async () => {
  const database = openDatabase(":memory:");
  const config = {
    publicUrl: "http://127.0.0.1",
    cliCommand: "npm run cli --",
    turnstileBypass: true,
    turnstileSiteKey: "",
    secureCookies: false,
    trustProxy: false
  };
  const server = createApp({ database, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;

  const configResponse = await fetch(`${base}/api/config`);
  assert.equal(configResponse.status, 200);
  assert.equal((await configResponse.json()).cliCommand, config.cliCommand);

  const createdResponse = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnstileToken: "development-bypass" })
  });
  assert.equal(createdResponse.status, 201);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM participants").get().count, 0);
  const created = await createdResponse.json();
  const invite = new URL(created.joinUrl);
  const joinToken = new URLSearchParams(invite.hash.slice(1)).get("join");

  const joinedResponse = await fetch(`${base}/api/rooms/${created.roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Grace", joinToken, turnstileToken: "development-bypass" })
  });
  assert.equal(joinedResponse.status, 201);
  const sessionCookie = joinedResponse.headers.get("set-cookie").split(";")[0];
  const importTokenResponse = await fetch(`${base}/api/rooms/${created.roomId}/import-token`, {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(importTokenResponse.status, 201);
  const importCommand = (await importTokenResponse.json()).command;
  assert.match(importCommand, new RegExp(`^npm run cli -- import --room ${base}/room/${created.roomId} --token `));
  const importToken = importCommand.match(/--token ([A-Za-z0-9_-]+)$/)[1];
  const importedResponse = await fetch(`${base}/api/rooms/${created.roomId}/prompts`, {
    method: "POST",
    headers: { authorization: `Bearer ${importToken}`, "content-type": "application/json" },
    body: JSON.stringify({ prompts: [{ text: "actual imported prompt", citation: "codex://test/http" }] })
  });
  assert.equal(importedResponse.status, 201);
  const roomResponse = await fetch(`${base}/api/rooms/${created.roomId}`, { headers: { cookie: sessionCookie } });
  assert.equal(roomResponse.status, 200);
  const roomState = await roomResponse.json();
  assert.equal(roomState.you.name, "Grace");
  assert.equal(roomState.totalPrompts, 1);

  await new Promise((resolve) => server.close(resolve));
  database.close();
});

test("WebSocket presence broadcasts joins and removes a client after its last socket closes", async (context) => {
  const database = openDatabase(":memory:");
  const config = {
    publicUrl: "http://127.0.0.1",
    turnstileBypass: true,
    turnstileSiteKey: "",
    secureCookies: false,
    trustProxy: false
  };
  const server = createApp({ database, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.roomEvents.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await createRoomOverHttp(base);
  const first = await joinRoomOverHttp(base, created, "Ada");

  const adaSocket = await openRoomSocket(base, created.roomId, first.cookie);
  const initial = await nextRoomState(adaSocket);
  assert.equal(initial.you.name, "Ada");
  assert.deepEqual(initial.participants.map((person) => person.name), ["Ada"]);

  const second = await joinRoomOverHttp(base, created, "Grace");
  const graceSocket = await openRoomSocket(base, created.roomId, second.cookie);
  const joined = await nextRoomState(adaSocket);
  assert.deepEqual(joined.participants.map((person) => person.name), ["Ada", "Grace"]);

  const secondGraceSocket = await openRoomSocket(base, created.roomId, second.cookie);
  const duplicateConnected = await nextRoomState(adaSocket);
  assert.deepEqual(duplicateConnected.participants.map((person) => person.name), ["Ada", "Grace"]);

  graceSocket.close();
  const oneSocketLeft = await nextRoomState(adaSocket);
  assert.deepEqual(oneSocketLeft.participants.map((person) => person.name), ["Ada", "Grace"]);

  secondGraceSocket.close();
  const left = await nextRoomState(adaSocket);
  assert.deepEqual(left.participants.map((person) => person.name), ["Ada"]);

  adaSocket.close();
});

test("WebSocket rejects room viewers without a participant session", async () => {
  const database = openDatabase(":memory:");
  const config = {
    publicUrl: "http://127.0.0.1",
    turnstileBypass: true,
    turnstileSiteKey: "",
    secureCookies: false,
    trustProxy: false
  };
  const server = createApp({ database, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await createRoomOverHttp(base);
  const status = await rejectedWebSocketStatus(base, created.roomId);
  assert.equal(status, 401);
  server.roomEvents.close();
  await new Promise((resolve) => server.close(resolve));
  database.close();
});

test("WebSocket sends regular protocol pings", async () => {
  const database = openDatabase(":memory:");
  const config = {
    publicUrl: "http://127.0.0.1",
    turnstileBypass: true,
    turnstileSiteKey: "",
    secureCookies: false,
    trustProxy: false
  };
  const eventHub = new RoomEventHub({ keepAliveMs: 20 });
  const server = createApp({ database, config, eventHub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await createRoomOverHttp(base);
  const participant = await joinRoomOverHttp(base, created, "Ada");
  const socket = await openRoomSocket(base, created.roomId, participant.cookie);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket ping was not received")), 500);
    socket.once("ping", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  socket.close();
  server.roomEvents.close();
  await new Promise((resolve) => server.close(resolve));
  database.close();
});

test("server timer reveals an unfinished vote and broadcasts the result", async (context) => {
  const database = openDatabase(":memory:");
  const config = {
    publicUrl: "http://127.0.0.1",
    cliCommand: "npm run cli --",
    voteTimeoutSeconds: 0.05,
    turnstileBypass: true,
    turnstileSiteKey: "",
    secureCookies: false,
    trustProxy: false
  };
  const server = createApp({ database, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.roomEvents.close();
    await new Promise((resolve) => server.close(resolve));
    database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;
  const room = await createRoomOverHttp(base);
  const participant = await joinRoomOverHttp(base, room, "Ada");
  const importResponse = await fetch(`${base}/api/rooms/${room.roomId}/import-token`, {
    method: "POST",
    headers: { cookie: participant.cookie, "content-type": "application/json" },
    body: "{}"
  });
  const command = (await importResponse.json()).command;
  const token = command.match(/--token ([A-Za-z0-9_-]+)$/)[1];
  await fetch(`${base}/api/rooms/${room.roomId}/prompts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompts: [{ text: "wait for it" }] })
  });

  const socket = await openRoomSocket(base, room.roomId, participant.cookie);
  await nextRoomState(socket);
  await fetch(`${base}/api/rooms/${room.roomId}/start`, {
    method: "POST",
    headers: { cookie: participant.cookie, "content-type": "application/json" },
    body: "{}"
  });
  assert.equal((await nextRoomState(socket)).game.phase, "voting");
  assert.equal((await nextRoomState(socket)).game.phase, "reveal");
  socket.close();
});

async function createRoomOverHttp(base) {
  const response = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnstileToken: "development-bypass" })
  });
  const room = await response.json();
  const invite = new URL(room.joinUrl);
  return {
    ...room,
    joinToken: new URLSearchParams(invite.hash.slice(1)).get("join")
  };
}

async function joinRoomOverHttp(base, room, name) {
  const response = await fetch(`${base}/api/rooms/${room.roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      joinToken: room.joinToken,
      turnstileToken: "development-bypass"
    })
  });
  assert.equal(response.status, 201);
  return { cookie: response.headers.get("set-cookie").split(";")[0] };
}

async function openRoomSocket(base, roomId, cookie) {
  const url = `${base.replace(/^http/, "ws")}/api/rooms/${roomId}/socket`;
  const socket = new WebSocket(url, { headers: { cookie } });
  socket.roomStates = [];
  socket.roomStateWaiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    assert.equal(message.type, "room_state");
    const waiter = socket.roomStateWaiters.shift();
    if (waiter) waiter(message.room);
    else socket.roomStates.push(message.room);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextRoomState(socket) {
  if (socket.roomStates.length > 0) return Promise.resolve(socket.roomStates.shift());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Room state was not received")), 1_000);
    socket.roomStateWaiters.push((room) => {
      clearTimeout(timeout);
      resolve(room);
    });
  });
}

function rejectedWebSocketStatus(base, roomId) {
  return new Promise((resolve, reject) => {
    const url = `${base.replace(/^http/, "ws")}/api/rooms/${roomId}/socket`;
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => reject(new Error("WebSocket unexpectedly opened")));
    socket.once("error", reject);
  });
}
