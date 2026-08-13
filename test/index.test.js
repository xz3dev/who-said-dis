import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBoundedLines } from "../apps/cli/src/history-files.js";
import { readCodexPrompts, resolveCodexHome } from "../apps/cli/src/index.js";

async function fixture(lines) {
  const directory = await mkdtemp(join(tmpdir(), "who-said-dis-"));
  await writeFile(join(directory, "history.jsonl"), `${lines.join("\n")}\n`);
  return directory;
}

test("returns only the most recent prompts in chronological order", async () => {
  const codexHome = await fixture([
    JSON.stringify({ session_id: "alpha", ts: 1_700_000_000, text: "first" }),
    JSON.stringify({ session_id: "alpha", ts: 1_700_000_001, text: "second" }),
    JSON.stringify({ session_id: "beta", ts: 1_700_000_002, text: "third" })
  ]);

  const result = await readCodexPrompts({ codexHome, limit: 2 });

  assert.deepEqual(
    result.prompts.map(({ text, ordinal }) => ({ text, ordinal })),
    [
      { text: "second", ordinal: 2 },
      { text: "third", ordinal: 1 }
    ]
  );
  assert.match(result.prompts[0].citation, /^codex:\/\/session\/alpha\/prompt\/2#sha256=/);
});

test("ignores attachments, non-prompt records, blank prompts, and malformed JSON", async () => {
  const codexHome = await fixture([
    "not json",
    JSON.stringify({ session_id: "alpha", ts: 1, text: "" }),
    JSON.stringify({ session_id: "alpha", ts: 2, file: "secret.pdf" }),
    JSON.stringify({ session_id: "alpha", ts: 3, text: "keep me", attachments: ["ignored.png"] })
  ]);

  const result = await readCodexPrompts({ codexHome });

  assert.deepEqual(result.prompts.map((prompt) => prompt.text), ["keep me"]);
  assert.equal(result.diagnostics.invalidLines, 1);
  assert.equal(result.diagnostics.ignoredLines, 2);
});

test("reads prompts from every session origin and ignores attached files", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "who-said-dis-sessions-"));
  const sessions = join(codexHome, "sessions", "2026", "08", "13");
  await mkdir(sessions, { recursive: true });

  const desktopSession = join(
    sessions,
    "rollout-2026-08-13T10-00-00-11111111-1111-1111-1111-111111111111.jsonl"
  );
  const cliSession = join(
    sessions,
    "rollout-2026-08-13T11-00-00-22222222-2222-2222-2222-222222222222.jsonl"
  );

  await writeFile(
    desktopSession,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "11111111-1111-1111-1111-111111111111",
          originator: "Codex Desktop",
          source: "vscode"
        }
      }),
      JSON.stringify({
        timestamp: "2026-08-13T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "desktop prompt",
          images: ["ignored.png"]
        }
      })
    ].join("\n")
  );
  await writeFile(
    cliSession,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "22222222-2222-2222-2222-222222222222",
          originator: "codex-tui",
          source: "cli"
        }
      }),
      JSON.stringify({
        timestamp: "2026-08-13T11:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "cli prompt" }
      })
    ].join("\n")
  );

  const result = await readCodexPrompts({ codexHome });

  assert.deepEqual(
    result.prompts.map(({ text, client, surface }) => ({ text, client, surface })),
    [
      { text: "desktop prompt", client: "Codex Desktop", surface: "vscode" },
      { text: "cli prompt", client: "codex-tui", surface: "cli" }
    ]
  );
  assert.equal(result.prompts[0].source.kind, "session");
  assert.equal("images" in result.prompts[0], false);
});

test("rejects invalid limits", async () => {
  await assert.rejects(() => readCodexPrompts({ limit: 0 }), /between 1 and 10000/);
  await assert.rejects(() => readCodexPrompts({ limit: 10_001 }), /between 1 and 10000/);
});

test("resolves an explicit Codex home", () => {
  assert.equal(resolveCodexHome("./fixture"), join(process.cwd(), "fixture"));
});

test("discards oversized history records without buffering the rest of the file", async () => {
  const directory = await fixture(["0123456789", "valid"]);
  const lines = [];
  for await (const line of readBoundedLines(join(directory, "history.jsonl"), 8)) lines.push(line);
  assert.deepEqual(lines, [null, "valid"]);
});
