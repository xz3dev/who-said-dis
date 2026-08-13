import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli, uploadPrompts, verifyImportToken } from "../apps/cli/src/cli.js";
import { safeTerminalText } from "../apps/cli/src/terminal.js";

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
    "http://localhost:3000/room/abc_12345678",
    "a-valid-import-token_1234567890",
    [{ text: "actual prompt", citation: "codex://session/test/prompt/1", source: { path: "/private/file" } }],
    async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ imported: 1, name: "Ada" }) };
    }
  );

  assert.deepEqual(result, { imported: 1, name: "Ada" });
  assert.equal(request.url, "http://localhost:3000/api/rooms/abc_12345678/prompts");
  assert.equal(request.options.headers.authorization, "Bearer a-valid-import-token_1234567890");
  assert.equal(request.options.redirect, "error");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.options.body), {
    prompts: [{ text: "actual prompt", citation: "codex://session/test/prompt/1" }]
  });
  assert.equal(request.options.body.includes("private/file"), false);
});

test("verifies an import token without uploading prompts", async () => {
  let request;
  const result = await verifyImportToken(
    "http://localhost:3000/room/abc_12345678",
    "-valid-import-token_1234567890",
    async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ valid: true, name: "Ada", expiresAt: "2026-08-13T12:00:00.000Z" })
      };
    }
  );

  assert.equal(result.valid, true);
  assert.equal(request.url, "http://localhost:3000/api/rooms/abc_12345678/import-token/verify");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.authorization, "Bearer -valid-import-token_1234567890");
  assert.equal("body" in request.options, false);
});

test("import command runs the picker and sends its selections", async () => {
  const selected = { text: "picked prompt", citation: "codex://picked" };
  const token = "-valid_token_12345678901234567890";
  let uploaded;
  let authorization;
  let verified = false;
  const output = [];
  const provider = {
    id: "codex",
    displayName: "Codex",
    analyzerLabel: "Luna",
    readPrompts: async () => {
      assert.equal(verified, true);
      return [selected];
    },
    analyze: async () => [{ prompt: selected }]
  };
  await runCli(
    [
      "import",
      "--room",
      "http://localhost:3000/room/test_room_12",
      "--token",
      token
    ],
    { log: (value) => output.push(value), warn: () => {} },
    {
      scanInstallations: async () => [{ provider, installation: { label: "codex: /bin/codex" } }],
      promptApi: { checkbox: async () => [selected] },
      spinnerFactory: () => ({ start() {}, stop() {} }),
      fetchImpl: async (url, options) => {
        authorization = options.headers.authorization;
        if (url.endsWith("/import-token/verify")) {
          verified = true;
          return { ok: true, status: 200, json: async () => ({ valid: true, name: "Ada" }) };
        }
        uploaded = JSON.parse(options.body).prompts;
        return { ok: true, status: 201, json: async () => ({ imported: 1, name: "Ada" }) };
      }
    }
  );

  assert.deepEqual(uploaded, [{ text: "picked prompt", citation: "codex://picked" }]);
  assert.equal(verified, true);
  assert.equal(authorization, `Bearer ${token}`);
  assert.match(output[0], /Import code verified for Ada/);
  assert.match(output.at(-1), /Imported 1 prompt for Ada/);
});

test("does not scan prompt history when import-token verification fails", async () => {
  let scanned = false;
  await assert.rejects(
    () => runCli(
      [
        "import",
        "--room",
        "http://localhost:3000/room/test_room_12",
        "--token",
        "-invalid_token_123456789012345678"
      ],
      { log: () => {}, warn: () => {} },
      {
        scanInstallations: async () => {
          scanned = true;
          return [];
        },
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          json: async () => ({ error: "This import token is invalid, expired, or already used." })
        })
      }
    ),
    /invalid, expired, or already used/
  );
  assert.equal(scanned, false);
});

test("refuses plaintext remote uploads and unsafe room URL components", async () => {
  const prompts = [{ text: "selected", citation: "codex://selected" }];
  const token = "valid_token_12345678901234567890";
  await assert.rejects(
    () => uploadPrompts("http://example.com/room/abc_12345678", token, prompts),
    /must use HTTPS/
  );
  await assert.rejects(
    () => uploadPrompts("https://user@example.com/room/abc_12345678", token, prompts),
    /valid room URL/
  );
  await assert.rejects(
    () => uploadPrompts("https://example.com/room/abc_12345678#secret", token, prompts),
    /valid room URL/
  );
});

test("removes ANSI, control, and bidirectional override sequences from terminal text", () => {
  const unsafe = "safe\u001b]0;owned\u0007\u001b[31mred\u001b[0m\u202Etxt";
  const cleaned = safeTerminalText(unsafe);
  assert.equal(cleaned.includes("\u001b"), false);
  assert.equal(cleaned.includes("\u0007"), false);
  assert.equal(cleaned.includes("\u202E"), false);
  assert.match(cleaned, /saferedtxt/);
});
