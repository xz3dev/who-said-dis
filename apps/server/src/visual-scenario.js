import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  createRoom,
  importPrompts,
  issueImportToken,
  joinRoom,
  openDatabase,
  startNextRound
} from "./database.js";

const databasePath = resolve(process.argv[2] || "data/visual-scenario.sqlite");
const publicUrl = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const now = Date.now();
const playerNames = [
  "Ada Lovelace",
  "Grace Hopper",
  "Linus Torvalds",
  "Margaret Hamilton",
  "Ken Thompson",
  "Barbara Liskov",
  "Edsger Dijkstra",
  "Radia Perlman",
  "Donald Knuth",
  "Frances Allen",
  "Guido van Rossum",
  "James Gosling",
  "Brendan Eich",
  "Alexandria Montgomery"
];

for (const suffix of ["", "-shm", "-wal"]) rmSync(`${databasePath}${suffix}`, { force: true });
const database = openDatabase(databasePath);

function seedPlayers(room, timeOffset) {
  return playerNames.map((name, index) => ({
    name,
    ...joinRoom(database, room.publicId, room.joinToken, name, now + timeOffset + index)
  }));
}

function importOnePrompt(room, player, text, timeOffset) {
  const token = issueImportToken(database, room.publicId, player.sessionToken, now + timeOffset);
  importPrompts(database, room.publicId, token.token, [{ text }], now + timeOffset + 1);
}

const questionRoom = createRoom(database, now);
const questionPlayers = seedPlayers(questionRoom, 10);
importOnePrompt(
  questionRoom,
  questionPlayers[0],
  "Please fix the race condition without changing the API, the database schema, the tests, or—somehow—the behavior.",
  30
);
startNextRound(database, questionRoom.publicId, questionPlayers[1].sessionToken, 3_600, now + 40);

const leaderboardRoom = createRoom(database, now + 100);
const leaderboardPlayers = seedPlayers(leaderboardRoom, 110);
importOnePrompt(
  leaderboardRoom,
  leaderboardPlayers[0],
  "Why does the supposedly tiny refactor now require a distributed consensus protocol?",
  130
);

const storedRoom = database.prepare("SELECT id FROM rooms WHERE public_id = ?").get(leaderboardRoom.publicId);
const storedPrompt = database.prepare("SELECT id FROM prompts WHERE room_id = ?").get(storedRoom.id);
database.prepare("UPDATE prompts SET used = 1, played_round = 1 WHERE id = ?").run(storedPrompt.id);
const insertVote = database.prepare(
  "INSERT INTO votes (prompt_id, voter_id, guessed_participant_id, created_at, points) VALUES (?, ?, ?, ?, ?)"
);
leaderboardPlayers.forEach((player, index) => {
  insertVote.run(storedPrompt.id, player.participantId, leaderboardPlayers[0].participantId, now + 140 + index, 200 - index * 7);
});
database.prepare(
  "UPDATE rooms SET phase = 'finished', current_prompt_id = NULL, round_number = 1, vote_deadline = NULL, vote_started_at = NULL WHERE id = ?"
).run(storedRoom.id);

database.close();

console.log(JSON.stringify({
  databasePath,
  participantCountAfterJoining: 15,
  joinAs: "Visual Tester",
  questionJoinUrl: `${publicUrl}/room/${questionRoom.publicId}#join=${questionRoom.joinToken}`,
  leaderboardJoinUrl: `${publicUrl}/room/${leaderboardRoom.publicId}#join=${leaderboardRoom.joinToken}`
}, null, 2));
