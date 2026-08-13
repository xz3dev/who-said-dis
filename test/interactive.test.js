import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOrderedPrompts,
  readAllPrompts,
  runInteractiveCli,
  selectAnalyzer
} from "../apps/cli/src/interactive.js";

function prompt(text) {
  return { text, citation: "codex://test" };
}

function fixture() {
  const installation = {
    label: "codex: /usr/local/bin/codex",
    executablePath: "/usr/local/bin/codex"
  };
  const analyzed = ["one", "two", "three", "four", "five"].map((text, index) => ({
    rank: index + 1,
    score: 90 - index,
    prompt: prompt(text)
  }));
  const provider = {
    id: "codex",
    displayName: "Codex",
    analyzerLabel: "Luna",
    readPrompts: async () => analyzed.map((item) => item.prompt),
    analyze: async () => analyzed
  };
  return { installation, provider, analyzed };
}

test("interactive flow uses all histories, prefers Codex, and prints checked prompts", async () => {
  const { installation, provider } = fixture();
  const claudeInstallation = {
    label: "claude: /usr/local/bin/claude",
    executablePath: "/usr/local/bin/claude",
    dataHome: "/tmp/claude"
  };
  let claudeRead = false;
  let claudeAnalyzed = false;
  const claudeProvider = {
    id: "claude",
    displayName: "Claude",
    analyzerLabel: "Haiku",
    readPrompts: async () => {
      claudeRead = true;
      return [prompt("from claude")];
    },
    analyze: async () => {
      claudeAnalyzed = true;
      return [];
    }
  };
  installation.dataHome = "/tmp/codex";
  const output = [];
  const spinnerEvents = [];
  const result = await runInteractiveCli({
    io: { log: (value) => output.push(value) },
    scanInstallations: async () => [
      { installation: claudeInstallation, provider: claudeProvider },
      { installation, provider }
    ],
    spinnerFactory: (message) => ({
      start: () => spinnerEvents.push(["start", message]),
      stop: () => spinnerEvents.push(["stop", message])
    }),
    promptApi: {
      checkbox: async ({ choices }) => {
        assert.equal(choices.length, 5);
        assert.ok(choices.every((choice) => choice.checked));
        return [choices[0].value, choices[2].value];
      }
    }
  });

  assert.equal(result.status, "complete");
  assert.equal(claudeRead, true);
  assert.equal(claudeAnalyzed, false);
  assert.deepEqual(result.selections.map((item) => item.text), ["one", "three"]);
  assert.deepEqual(spinnerEvents, [
    ["start", "Scanning and analyzing prompt history..."],
    ["stop", "Scanning and analyzing prompt history..."]
  ]);
  assert.match(output.join("\n"), /1\. claude: \/usr\/local\/bin\/claude/);
  assert.match(output.join("\n"), /2\. codex: \/usr\/local\/bin\/codex/);
  assert.match(output.join("\n"), /Using Codex with Luna for analysis/);
  assert.match(output.join("\n"), /Using these:\n1\. one\n2\. three/);
});

test("analysis spinner stops when the provider fails", async () => {
  const { installation, provider } = fixture();
  provider.analyze = async () => {
    throw new Error("analysis failed");
  };
  let stopped = false;

  await assert.rejects(
    () =>
      runInteractiveCli({
        io: { log: () => {} },
        scanInstallations: async () => [{ installation, provider }],
        spinnerFactory: () => ({ start: () => {}, stop: () => { stopped = true; } }),
        promptApi: {}
      }),
    /analysis failed/
  );
  assert.equal(stopped, true);
});

test("falls back to Claude when Codex is unavailable", () => {
  const claude = { provider: { id: "claude" }, installation: {} };
  assert.equal(selectAnalyzer([claude]), claude);
});

test("ordered multiline output is stable", () => {
  assert.equal(formatOrderedPrompts([prompt("first\nline two"), prompt("second")]), "1. first\n   line two\n2. second");
  assert.equal(formatOrderedPrompts([prompt("safe\u001b[31mred\u001b[0m")]), "1. safered");
});

test("merges data stores, skips duplicate installations, and keeps the global recency limit", async () => {
  let reads = 0;
  const provider = {
    id: "codex",
    readPrompts: async () => {
      reads += 1;
      return [
        { ...prompt("old"), timestamp: "2025-01-01T00:00:00.000Z", citation: "one" },
        { ...prompt("new"), timestamp: "2025-01-02T00:00:00.000Z", citation: "two" }
      ];
    }
  };
  const found = [
    { provider, installation: { dataHome: "/same", executablePath: "/bin/a" } },
    { provider, installation: { dataHome: "/same", executablePath: "/bin/b" } }
  ];

  const prompts = await readAllPrompts(found, { limit: 1 });
  assert.equal(reads, 1);
  assert.deepEqual(prompts.map((item) => item.text), ["new"]);
});
