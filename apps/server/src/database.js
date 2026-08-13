import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_ANSWER_OPTIONS,
  MAX_PROMPT_LENGTH,
  MAX_PROMPTS_PER_IMPORT,
  MAX_ROOM_PARTICIPANTS,
  ROOM_TTL_MS
} from "../../../packages/shared/src/constants.js";

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE,
      join_token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'lobby',
      current_prompt_id INTEGER,
      round_number INTEGER NOT NULL DEFAULT 0,
      vote_deadline INTEGER,
      vote_started_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      session_token_hash TEXT NOT NULL UNIQUE,
      joined_at INTEGER NOT NULL,
      UNIQUE(room_id, normalized_name)
    );
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      citation TEXT,
      used INTEGER NOT NULL DEFAULT 0,
      played_round INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(participant_id, citation)
    );
    CREATE TABLE IF NOT EXISTS import_tokens (
      id INTEGER PRIMARY KEY,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS round_options (
      prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY(prompt_id, participant_id)
    );
    CREATE TABLE IF NOT EXISTS votes (
      prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      voter_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      guessed_participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      points INTEGER CHECK (points BETWEEN 0 AND 200),
      PRIMARY KEY(prompt_id, voter_id)
    );
    CREATE INDEX IF NOT EXISTS idx_participants_room_id ON participants(room_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_room_id ON prompts(room_id, used);
    CREATE INDEX IF NOT EXISTS idx_import_tokens_participant ON import_tokens(participant_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_expires_at ON rooms(expires_at);
  `);
  ensureColumn(database, "rooms", "phase", "TEXT NOT NULL DEFAULT 'lobby'");
  ensureColumn(database, "rooms", "current_prompt_id", "INTEGER");
  ensureColumn(database, "rooms", "round_number", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "rooms", "vote_deadline", "INTEGER");
  ensureColumn(database, "rooms", "vote_started_at", "INTEGER");
  ensureColumn(database, "prompts", "played_round", "INTEGER");
  ensureColumn(database, "votes", "points", "INTEGER CHECK (points BETWEEN 0 AND 200)");
  database.exec("PRAGMA optimize");
  return database;
}

export function createRoom(database, now = Date.now()) {
  cleanupExpiredRooms(database, now);
  const publicId = randomToken(9);
  const joinToken = randomToken(32);
  database.prepare(
    "INSERT INTO rooms (public_id, join_token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(publicId, hashToken(joinToken), now, now + ROOM_TTL_MS);
  return { publicId, joinToken, expiresAt: new Date(now + ROOM_TTL_MS).toISOString() };
}

export function joinRoom(database, publicId, joinToken, name, now = Date.now()) {
  cleanupExpiredRooms(database, now);
  const room = database.prepare(
    "SELECT id, join_token_hash, expires_at FROM rooms WHERE public_id = ?"
  ).get(publicId);
  if (!room || !safeTokenMatch(room.join_token_hash, joinToken)) return { error: "ROOM_NOT_FOUND" };

  const count = database.prepare("SELECT COUNT(*) AS count FROM participants WHERE room_id = ?").get(room.id).count;
  if (count >= MAX_ROOM_PARTICIPANTS) return { error: "ROOM_FULL" };

  const sessionToken = randomToken(32);
  try {
    const result = database.prepare(
      `INSERT INTO participants
       (room_id, name, normalized_name, session_token_hash, joined_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(room.id, name, name.toLocaleLowerCase(), hashToken(sessionToken), now);
    return { participantId: Number(result.lastInsertRowid), sessionToken };
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) return { error: "NAME_TAKEN" };
    throw error;
  }
}

export function getRoomForSession(database, publicId, sessionToken, now = Date.now()) {
  cleanupExpiredRooms(database, now);
  revealExpiredRound(database, publicId, now);
  if (!sessionToken) return null;
  const participant = database.prepare(
    `SELECT p.id, p.name, p.room_id, r.public_id, r.expires_at
     FROM participants p JOIN rooms r ON r.id = p.room_id
     WHERE r.public_id = ? AND p.session_token_hash = ?`
  ).get(publicId, hashToken(sessionToken));
  if (!participant) return null;

  const participants = database.prepare(
    `SELECT p.id, p.name, p.joined_at,
       (SELECT COUNT(*) FROM prompts WHERE prompts.participant_id = p.id) AS prompt_count,
       (SELECT COALESCE(SUM(
          CASE WHEN votes.guessed_participant_id = prompt_authors.participant_id
            THEN COALESCE(votes.points, 100) ELSE 0 END
        ), 0) FROM votes
          JOIN prompts prompt_authors ON prompt_authors.id = votes.prompt_id
          WHERE votes.voter_id = p.id) AS score
     FROM participants p WHERE p.room_id = ? ORDER BY p.joined_at, p.id`
  ).all(participant.room_id);
  const room = database.prepare(
    "SELECT phase, current_prompt_id, round_number, vote_deadline FROM rooms WHERE id = ?"
  ).get(participant.room_id);
  const game = buildGameState(database, participant.room_id, participant.id, room, participants);
  return {
    id: participant.public_id,
    expiresAt: new Date(participant.expires_at).toISOString(),
    you: {
      id: participant.id,
      name: participant.name,
      score: Number(participants.find((item) => item.id === participant.id)?.score || 0)
    },
    participants: participants.map((item) => ({
      id: item.id,
      name: item.name,
      joinedAt: new Date(item.joined_at).toISOString(),
      promptCount: Number(item.prompt_count),
      score: Number(item.score)
    })),
    totalPrompts: Number(database.prepare("SELECT COUNT(*) AS count FROM prompts WHERE room_id = ?").get(participant.room_id).count),
    game
  };
}

export function issueImportToken(database, publicId, sessionToken, now = Date.now()) {
  cleanupExpiredRooms(database, now);
  const participant = participantForSession(database, publicId, sessionToken);
  if (!participant) return { error: "UNAUTHORIZED" };
  const token = randomToken(32);
  const expiresAt = database.prepare("SELECT expires_at FROM rooms WHERE id = ?").get(participant.room_id).expires_at;
  database.prepare("INSERT INTO import_tokens (participant_id, token_hash, expires_at) VALUES (?, ?, ?)")
    .run(participant.id, hashToken(token), expiresAt);
  return { token, participantId: participant.id, name: participant.name };
}

export function importPrompts(database, publicId, importToken, values, now = Date.now()) {
  cleanupExpiredRooms(database, now);
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PROMPTS_PER_IMPORT) {
    return { error: "INVALID_PROMPTS" };
  }
  const prompts = values.map(normalizePrompt);
  if (prompts.some((prompt) => !prompt)) return { error: "INVALID_PROMPTS" };
  const participant = participantForImportToken(database, publicId, importToken, now);
  if (!participant) return { error: "UNAUTHORIZED" };

  transaction(database, () => {
    database.prepare("DELETE FROM prompts WHERE participant_id = ? AND used = 0").run(participant.id);
    const insert = database.prepare(
      "INSERT OR IGNORE INTO prompts (room_id, participant_id, text, citation, used, created_at) VALUES (?, ?, ?, ?, 0, ?)"
    );
    for (const prompt of prompts) insert.run(participant.room_id, participant.id, prompt.text, prompt.citation, now);
  });
  const count = database.prepare("SELECT COUNT(*) AS count FROM prompts WHERE participant_id = ? AND used = 0").get(participant.id).count;
  return { imported: Number(count), name: participant.name };
}

export function startNextRound(database, publicId, sessionToken, timeoutSeconds, now = Date.now()) {
  cleanupExpiredRooms(database, now);
  const participant = participantForSession(database, publicId, sessionToken);
  if (!participant) return { error: "UNAUTHORIZED" };
  const room = database.prepare("SELECT id, phase, round_number FROM rooms WHERE id = ?").get(participant.room_id);
  if (!room || !["lobby", "reveal"].includes(room.phase)) return { error: "INVALID_PHASE" };
  const prompt = database.prepare(
    "SELECT id, participant_id FROM prompts WHERE room_id = ? AND used = 0 ORDER BY RANDOM() LIMIT 1"
  ).get(room.id);
  if (!prompt) {
    database.prepare(
      "UPDATE rooms SET phase = 'finished', current_prompt_id = NULL, vote_deadline = NULL, vote_started_at = NULL WHERE id = ?"
    ).run(room.id);
    return { phase: "finished" };
  }

  const others = database.prepare(
    "SELECT id FROM participants WHERE room_id = ? AND id != ? ORDER BY RANDOM() LIMIT ?"
  ).all(room.id, prompt.participant_id, MAX_ANSWER_OPTIONS - 1);
  const optionIds = shuffle([prompt.participant_id, ...others.map((item) => item.id)]);
  const deadline = now + timeoutSeconds * 1000;
  transaction(database, () => {
    database.prepare("UPDATE prompts SET used = 1, played_round = ? WHERE id = ?").run(room.round_number + 1, prompt.id);
    database.prepare("DELETE FROM round_options WHERE prompt_id = ?").run(prompt.id);
    const addOption = database.prepare("INSERT INTO round_options (prompt_id, participant_id, position) VALUES (?, ?, ?)");
    optionIds.forEach((id, index) => addOption.run(prompt.id, id, index));
    database.prepare(
      "UPDATE rooms SET phase = 'voting', current_prompt_id = ?, round_number = ?, vote_deadline = ?, vote_started_at = ? WHERE id = ?"
    ).run(prompt.id, room.round_number + 1, deadline, now, room.id);
  });
  return { phase: "voting", deadline };
}

export function castVote(database, publicId, sessionToken, guessedParticipantId, now = Date.now()) {
  cleanupExpiredRooms(database, now);
  revealExpiredRound(database, publicId, now);
  const participant = participantForSession(database, publicId, sessionToken);
  if (!participant) return { error: "UNAUTHORIZED" };
  const room = database.prepare(
    "SELECT id, phase, current_prompt_id, vote_deadline, vote_started_at FROM rooms WHERE id = ?"
  ).get(participant.room_id);
  if (!room || room.phase !== "voting" || now >= room.vote_deadline) return { error: "VOTING_CLOSED" };
  const option = database.prepare(
    `SELECT prompt.participant_id AS correct_participant_id
     FROM round_options option
     JOIN prompts prompt ON prompt.id = option.prompt_id
     WHERE option.prompt_id = ? AND option.participant_id = ?`
  ).get(room.current_prompt_id, guessedParticipantId);
  if (!option) return { error: "INVALID_OPTION" };
  const correct = guessedParticipantId === option.correct_participant_id;
  const points = correct ? calculateVotePoints(room.vote_started_at, room.vote_deadline, now) : 0;
  try {
    database.prepare(
      "INSERT INTO votes (prompt_id, voter_id, guessed_participant_id, created_at, points) VALUES (?, ?, ?, ?, ?)"
    ).run(room.current_prompt_id, participant.id, guessedParticipantId, now, points);
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) return { error: "ALREADY_VOTED" };
    throw error;
  }
  const voteCount = database.prepare("SELECT COUNT(*) AS count FROM votes WHERE prompt_id = ?").get(room.current_prompt_id).count;
  const participantCount = database.prepare("SELECT COUNT(*) AS count FROM participants WHERE room_id = ?").get(room.id).count;
  if (voteCount >= participantCount) revealCurrentRound(database, room.id);
  return { accepted: true, revealed: voteCount >= participantCount };
}

export function revealExpiredRound(database, publicId, now = Date.now()) {
  const room = database.prepare(
    "SELECT id, phase, vote_deadline FROM rooms WHERE public_id = ?"
  ).get(publicId);
  if (!room || room.phase !== "voting" || !room.vote_deadline || now < room.vote_deadline) return false;
  revealCurrentRound(database, room.id);
  return true;
}

export function listVotingRounds(database) {
  return database.prepare(
    "SELECT public_id AS roomId, vote_deadline AS deadline FROM rooms WHERE phase = 'voting' AND vote_deadline IS NOT NULL"
  ).all();
}

export function cleanupExpiredRooms(database, now = Date.now()) {
  database.prepare("DELETE FROM import_tokens WHERE expires_at <= ?").run(now);
  database.prepare("DELETE FROM rooms WHERE expires_at <= ?").run(now);
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function safeTokenMatch(expectedHash, token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function randomToken(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function participantForSession(database, publicId, token) {
  if (!token) return null;
  return database.prepare(
    `SELECT p.id, p.name, p.room_id FROM participants p
     JOIN rooms r ON r.id = p.room_id
     WHERE r.public_id = ? AND p.session_token_hash = ?`
  ).get(publicId, hashToken(token));
}

function participantForImportToken(database, publicId, token, now) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  return database.prepare(
    `SELECT p.id, p.name, p.room_id FROM import_tokens t
     JOIN participants p ON p.id = t.participant_id
     JOIN rooms r ON r.id = p.room_id
     WHERE r.public_id = ? AND t.token_hash = ? AND t.expires_at > ?`
  ).get(publicId, hashToken(token), now);
}

function normalizePrompt(value) {
  if (!value || typeof value.text !== "string") return null;
  const text = value.text.trim();
  if (!text || text.length > MAX_PROMPT_LENGTH || text.split(/\r?\n/).length > 3) return null;
  const citation = typeof value.citation === "string" && value.citation.length <= 500 ? value.citation : null;
  return { text, citation };
}

function buildGameState(database, roomId, viewerId, room, participants) {
  if (room.phase === "lobby") return { phase: "lobby", canStart: participants.some((item) => item.prompt_count > 0) };
  if (room.phase === "finished") {
    return {
      phase: "finished",
      round: room.round_number,
      standings: participants
        .map((person) => ({ id: person.id, name: person.name, score: Number(person.score) }))
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)),
      recap: buildGameRecap(database, roomId, participants)
    };
  }
  const prompt = database.prepare("SELECT id, text, participant_id FROM prompts WHERE id = ?").get(room.current_prompt_id);
  if (!prompt) return { phase: "finished", round: room.round_number };
  const options = database.prepare(
    `SELECT p.id, p.name FROM round_options o
     JOIN participants p ON p.id = o.participant_id
     WHERE o.prompt_id = ? ORDER BY o.position`
  ).all(prompt.id);
  const votes = database.prepare(
    `SELECT v.voter_id, voter.name AS voter_name, v.guessed_participant_id, v.points
     FROM votes v JOIN participants voter ON voter.id = v.voter_id
     WHERE v.prompt_id = ? ORDER BY v.created_at, v.voter_id`
  ).all(prompt.id);
  const yourVote = votes.find((vote) => vote.voter_id === viewerId)?.guessed_participant_id || null;
  const state = {
    phase: room.phase,
    round: room.round_number,
    prompt: { id: prompt.id, text: prompt.text },
    options,
    deadline: room.vote_deadline ? new Date(room.vote_deadline).toISOString() : null,
    voteCount: votes.length,
    participantCount: participants.length,
    yourVoteId: yourVote
  };
  if (room.phase === "reveal") {
    state.correctParticipantId = prompt.participant_id;
    state.results = participants.map((person) => {
      const vote = votes.find((item) => item.voter_id === person.id);
      const correct = vote?.guessed_participant_id === prompt.participant_id;
      return {
        participantId: person.id,
        name: person.name,
        guessParticipantId: vote?.guessed_participant_id || null,
        correct,
        points: correct ? Number(vote.points ?? 100) : 0
      };
    });
  }
  return state;
}

function buildGameRecap(database, roomId, participants) {
  const prompts = database.prepare(
    `SELECT prompt.id, prompt.text, prompt.participant_id, prompt.played_round,
            author.name AS author_name
     FROM prompts prompt
     JOIN participants author ON author.id = prompt.participant_id
     WHERE prompt.room_id = ? AND prompt.used = 1
     ORDER BY COALESCE(prompt.played_round, prompt.id), prompt.id`
  ).all(roomId);
  const votesForPrompt = database.prepare(
    `SELECT vote.voter_id, vote.guessed_participant_id, vote.points, guessed.name AS guessed_name
     FROM votes vote
     JOIN participants guessed ON guessed.id = vote.guessed_participant_id
     WHERE vote.prompt_id = ?`
  );
  const optionsForPrompt = database.prepare(
    `SELECT participant.id, participant.name
     FROM round_options option
     JOIN participants participant ON participant.id = option.participant_id
     WHERE option.prompt_id = ?
     ORDER BY option.position`
  );
  return prompts.map((prompt, index) => {
    const votes = votesForPrompt.all(prompt.id);
    return {
      round: Number(prompt.played_round || index + 1),
      prompt: prompt.text,
      author: { id: prompt.participant_id, name: prompt.author_name },
      options: optionsForPrompt.all(prompt.id),
      results: participants.map((person) => {
        const vote = votes.find((item) => item.voter_id === person.id);
        const correct = vote?.guessed_participant_id === prompt.participant_id;
        return {
          participantId: person.id,
          name: person.name,
          guessParticipantId: vote?.guessed_participant_id || null,
          guessName: vote?.guessed_name || null,
          correct,
          points: correct ? Number(vote.points ?? 100) : 0
        };
      })
    };
  });
}

function revealCurrentRound(database, roomId) {
  database.prepare(
    "UPDATE rooms SET phase = 'reveal', vote_deadline = NULL, vote_started_at = NULL WHERE id = ? AND phase = 'voting'"
  ).run(roomId);
}

export function calculateVotePoints(startedAt, deadline, votedAt) {
  const duration = deadline - startedAt;
  if (!Number.isFinite(duration) || duration <= 0) return 100;
  const remainingRatio = Math.max(0, Math.min(1, (deadline - votedAt) / duration));
  return Math.round(100 * (1 + remainingRatio));
}

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    callback();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function shuffle(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
