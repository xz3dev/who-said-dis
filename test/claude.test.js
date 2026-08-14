import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { readClaudePrompts, resolveClaudeHome } from "../apps/cli/src/claude.js";
import {
  buildClaudeJudgeArgs,
  runClaudeFunnyJudge,
  scanClaudeInstallations
} from "../apps/cli/src/providers/claude.js";

test("reads recent Claude prompts and excludes pasted attachments", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "who-said-dis-claude-history-"));
  const historyPath = join(claudeHome, "history.jsonl");
  const records = [
    {
      display: "first prompt",
      pastedContents: { "1": { content: "SECRET ATTACHMENT" } },
      timestamp: 1_700_000_000_000,
      project: "/tmp/project",
      sessionId: "session-a"
    },
    { display: "second prompt", pastedContents: {}, timestamp: 1_700_000_001_000, sessionId: "session-a" },
    { display: "third prompt", pastedContents: {}, timestamp: 1_700_000_002_000, sessionId: "session-b" }
  ];
  await writeFile(historyPath, `${records.map(JSON.stringify).join("\n")}\nnot-json\n`);

  const result = await readClaudePrompts({ claudeHome, limit: 2 });
  const unlimited = await readClaudePrompts({ claudeHome, unlimited: true });

  assert.deepEqual(result.prompts.map((prompt) => prompt.text), ["second prompt", "third prompt"]);
  assert.ok(result.prompts.every((prompt) => !prompt.text.includes("SECRET ATTACHMENT")));
  assert.equal(result.prompts[0].provider, "claude");
  assert.equal(result.prompts[0].client, "Claude Code");
  assert.match(result.prompts[0].citation, /^claude:\/\/session\/session-a\/prompt\/2#sha256=/);
  assert.equal(result.diagnostics.invalidLines, 1);
  assert.deepEqual(unlimited.prompts.map((prompt) => prompt.text), [
    "first prompt",
    "second prompt",
    "third prompt"
  ]);
});

test("Claude unlimited mode reads beyond the normal prompt cap", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "who-said-dis-claude-unlimited-"));
  const records = Array.from({ length: 105 }, (_, index) => ({
    display: `prompt ${index}`,
    timestamp: index + 1,
    sessionId: "session-a"
  }));
  await writeFile(join(claudeHome, "history.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`);

  const normal = await readClaudePrompts({ claudeHome });
  const unlimited = await readClaudePrompts({ claudeHome, unlimited: true });

  assert.equal(normal.prompts.length, 100);
  assert.equal(unlimited.prompts.length, 105);
});

test("merges project transcripts while excluding tool results, metadata, and subagents", async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), "who-said-dis-claude-sessions-"));
  const project = join(claudeHome, "projects", "project-a");
  const subagents = join(project, "subagents");
  await mkdir(subagents, { recursive: true });
  await writeFile(
    join(project, "session-a.jsonl"),
    [
      { type: "user", sessionId: "session-a", timestamp: "2025-01-01T00:00:00.000Z", message: { role: "user", content: "direct prompt" } },
      { type: "user", sessionId: "session-a", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", content: "SECRET OUTPUT" }] } },
      { type: "user", isMeta: true, sessionId: "session-a", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "user", content: "hidden metadata" } },
      { type: "attachment", attachment: { extracted_content: "SECRET FILE" } }
    ].map(JSON.stringify).join("\n")
  );
  await writeFile(
    join(subagents, "agent-a.jsonl"),
    `${JSON.stringify({ type: "user", timestamp: "2025-01-01T00:00:03.000Z", message: { role: "user", content: "internal agent task" } })}\n`
  );

  const result = await readClaudePrompts({ claudeHome });

  assert.deepEqual(result.prompts.map((prompt) => prompt.text), ["direct prompt"]);
  assert.equal(result.prompts[0].surface, "project");
  assert.equal(result.prompts[0].source.kind, "session");
  assert.equal(result.files.length, 1);
});

test("Claude scanner finds an executable and its configured data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "who-said-dis-claude-provider-"));
  const bin = join(root, "bin");
  const claudeHome = join(root, "claude-home");
  const executable = join(bin, "claude");
  await mkdir(bin);
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);

  const installations = await scanClaudeInstallations({
    env: { PATH: [bin].join(delimiter), CLAUDE_CONFIG_DIR: claudeHome },
    home: root,
    platform: process.platform
  });

  assert.equal(installations.length, 1);
  assert.equal(installations[0].label, `claude: ${executable}`);
  assert.equal(installations[0].dataHome, claudeHome);
});

test("Claude judge uses Haiku without tools or session persistence", () => {
  const args = buildClaudeJudgeArgs({ type: "object" });
  assert.deepEqual(args.slice(0, 5), ["--print", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome"]);
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4), ["--model", "haiku", "--effort", "medium"]);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("json"));
});

test("resolves an explicit Claude home", () => {
  assert.equal(resolveClaudeHome("/tmp/custom-claude"), "/tmp/custom-claude");
});

test("Claude judge disables hooks and tools in a disposable empty directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "who-said-dis-claude-judge-test-"));
  const executable = join(directory, "fake-claude");
  const capture = join(directory, "capture.json");
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), args }));
  process.stdout.write(JSON.stringify({ structured_output: { results: [{ id: "candidate-0001", score: 88 }] } }));
});
`);
  await chmod(executable, 0o755);

  const result = await runClaudeFunnyJudge(
    [{ id: "candidate-0001", prompt: { text: "WHY?!" } }],
    { top: 1, model: "haiku", effort: "medium", claudeBinary: executable }
  );
  const invocation = JSON.parse(await readFile(capture, "utf8"));

  assert.equal(result[0].id, "candidate-0001");
  assert.notEqual(invocation.cwd, process.cwd());
  assert.ok(invocation.args.includes("--safe-mode"));
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf("--tools"), invocation.args.indexOf("--tools") + 2),
    ["--tools", ""]
  );
  await assert.rejects(() => access(invocation.cwd));
});
