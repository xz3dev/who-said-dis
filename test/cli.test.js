import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli, uploadPrompts } from "../apps/cli/src/cli.js";

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

test("uploads only selected prompt text and citations with the room token", async () => {
  let request;
  const result = await uploadPrompts(
    "http://localhost:3000/room/abc_123",
    "a-valid-import-token_1234567890",
    [{ text: "actual prompt", citation: "codex://session/test/prompt/1", source: { path: "/private/file" } }],
    async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ imported: 1, name: "Ada" }) };
    }
  );

  assert.deepEqual(result, { imported: 1, name: "Ada" });
  assert.equal(request.url, "http://localhost:3000/api/rooms/abc_123/prompts");
  assert.equal(request.options.headers.authorization, "Bearer a-valid-import-token_1234567890");
  assert.deepEqual(JSON.parse(request.options.body), {
    prompts: [{ text: "actual prompt", citation: "codex://session/test/prompt/1" }]
  });
  assert.equal(request.options.body.includes("private/file"), false);
});

test("import command runs the picker and sends its selections", async () => {
  const selected = { text: "picked prompt", citation: "codex://picked" };
  let uploaded;
  const output = [];
  const provider = {
    id: "codex",
    displayName: "Codex",
    analyzerLabel: "Luna",
    readPrompts: async () => [selected],
    analyze: async () => [{ prompt: selected }]
  };
  await runCli(
    ["import", "--room", "http://localhost:3000/room/test-room", "--token", "valid_token_12345678901234567890"],
    { log: (value) => output.push(value), warn: () => {} },
    {
      scanInstallations: async () => [{ provider, installation: { label: "codex: /bin/codex" } }],
      promptApi: { checkbox: async () => [selected] },
      spinnerFactory: () => ({ start() {}, stop() {} }),
      fetchImpl: async (_url, options) => {
        uploaded = JSON.parse(options.body).prompts;
        return { ok: true, json: async () => ({ imported: 1, name: "Ada" }) };
      }
    }
  );

  assert.deepEqual(uploaded, [{ text: "picked prompt", citation: "codex://picked" }]);
  assert.match(output.at(-1), /Imported 1 prompt for Ada/);
});
