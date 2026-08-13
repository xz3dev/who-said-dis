import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";

test("prints machine-readable JSON", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "who-said-dis-cli-"));
  await writeFile(
    join(codexHome, "history.jsonl"),
    `${JSON.stringify({ session_id: "session-1", ts: 1_700_000_000, text: "hello" })}\n`
  );

  const output = [];
  await runCli(["--codex-home", codexHome, "--json"], {
    log: (value) => output.push(value),
    warn: () => {}
  });

  const parsed = JSON.parse(output.join("\n"));
  assert.equal(parsed[0].text, "hello");
  assert.equal(parsed[0].provider, "codex");
});

test("prints help without reading history", async () => {
  const output = [];
  await runCli(["--help"], { log: (value) => output.push(value) });
  assert.match(output[0], /--limit/);
});
