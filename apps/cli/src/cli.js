import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_FUNNY_CANDIDATES,
  DEFAULT_FUNNY_EFFORT,
  DEFAULT_FUNNY_MODEL,
  DEFAULT_FUNNY_SCAN,
  DEFAULT_FUNNY_TOP,
  DEFAULT_LIMIT,
  findFunniestPrompts,
  readCodexPrompts
} from "./index.js";
import { runInteractiveCli } from "./interactive.js";

const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");

export async function runCli(args, io = console, dependencies = {}) {
  if (args.length === 0) {
    await runInteractiveCli({ io, ...dependencies });
    return;
  }

  const options = parseArgs(args);

  if (options.help) {
    io.log(helpText());
    return;
  }

  if (options.version) {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    io.log(packageJson.version);
    return;
  }

  if (options.command === "import") {
    const result = await runInteractiveCli({ io, ...dependencies });
    if (result.status !== "complete" || result.selections.length === 0) {
      io.log("No prompts imported.");
      return;
    }
    const imported = await uploadPrompts(options.room, options.token, result.selections, dependencies.fetchImpl || fetch);
    io.log(`\nImported ${imported.imported} prompt${imported.imported === 1 ? "" : "s"} for ${imported.name}.`);
    return;
  }

  if (options.command === "funny") {
    await runFunnyCommand(options, io);
    return;
  }

  const result = await readCodexPrompts(options);

  if (options.json) {
    io.log(JSON.stringify(result.prompts, null, 2));
    return;
  }

  if (result.prompts.length === 0) {
    io.log("No saved Codex prompts found.");
    return;
  }

  io.log(
    result.prompts
      .map((prompt, index) => formatPrompt(prompt, index + 1))
      .join("\n\n")
  );

  if (result.diagnostics.invalidLines > 0) {
    io.warn(`Skipped ${result.diagnostics.invalidLines} malformed history line(s).`);
  }
}

function parseArgs(args) {
  const funny = args[0] === "funny";
  const importing = args[0] === "import";
  const options = importing
    ? { command: "import" }
    : funny
    ? {
        command: "funny",
        scan: DEFAULT_FUNNY_SCAN,
        top: DEFAULT_FUNNY_TOP,
        candidates: DEFAULT_FUNNY_CANDIDATES,
        model: DEFAULT_FUNNY_MODEL,
        effort: DEFAULT_FUNNY_EFFORT
      }
    : { command: "list", limit: DEFAULT_LIMIT };

  for (let index = funny || importing ? 1 : 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "-n":
      case "--limit":
        options.limit = requiredValue(args, ++index, argument);
        break;
      case "--codex-home":
        options.codexHome = requiredValue(args, ++index, argument);
        break;
      case "--history":
        options.historyPath = requiredValue(args, ++index, argument);
        break;
      case "--room":
        if (!importing) throw new Error("--room is only available with the import command");
        options.room = requiredValue(args, ++index, argument);
        break;
      case "--token":
        if (!importing) throw new Error("--token is only available with the import command");
        options.token = requiredValue(args, ++index, argument);
        break;
      case "--scan":
        requireFunny(funny, argument);
        options.scan = requiredValue(args, ++index, argument);
        break;
      case "--candidates":
        requireFunny(funny, argument);
        options.candidates = requiredValue(args, ++index, argument);
        break;
      case "--model":
        requireFunny(funny, argument);
        options.model = requiredValue(args, ++index, argument);
        break;
      case "--effort":
        requireFunny(funny, argument);
        options.effort = requiredValue(args, ++index, argument);
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}\n\n${helpText()}`);
    }
  }

  if (importing && !options.help && !options.version) {
    if (!options.room) throw new Error("import requires --room");
    if (!options.token) throw new Error("import requires --token");
  }

  return options;
}

function requireFunny(funny, option) {
  if (!funny) throw new Error(`${option} is only available with the funny command`);
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function formatPrompt(prompt, displayIndex) {
  const origin = prompt.client === "unknown" ? prompt.surface : prompt.client;
  const header = `${displayIndex}. ${prompt.timestamp || "unknown time"} · ${origin} · ${prompt.sessionId}`;
  return `${header}\n${prompt.text}\n${prompt.citation}`;
}

function helpText() {
  return `who-said-dis — interactively discover and analyze local LLM prompt history

Usage:
  who-said-dis                 Start the interactive wizard
  who-said-dis import --room <url> --token <token>
  who-said-dis [list options]  Inspect normalized prompt records
  who-said-dis funny [options]

Options:
  -n, --limit <count>       Number of recent prompts (default: 100)
      --codex-home <path>   Codex data directory (default: CODEX_HOME or ~/.codex)
      --history <path>      Read only a specific Codex history.jsonl
      --json                Output structured JSON
  -v, --version             Print the package version
  -h, --help                Show this help

Funny options:
      --scan <count>        Recent prompts to scan locally (default: 10000)
      --candidates <count>  Shortlist sent to Codex (default: 250)
      --model <model>       Codex judge model (default: gpt-5.6-luna)
      --effort <effort>     Reasoning effort (default: medium)

Reading and pre-ranking are local and read-only. The funny command sends shortlisted
prompt text through your authenticated Codex CLI connection for model inference.`;
}

export async function uploadPrompts(roomUrl, token, prompts, fetchImpl = fetch) {
  let url;
  try {
    url = new URL(roomUrl);
  } catch {
    throw new Error("--room must be a valid room URL");
  }
  const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]+)\/?$/);
  if (!match || !/^https?:$/.test(url.protocol)) throw new Error("--room must be a valid room URL");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error("--token is invalid");

  const response = await fetchImpl(`${url.origin}/api/rooms/${match[1]}/prompts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      prompts: prompts.map((prompt) => ({ text: prompt.text, citation: prompt.citation }))
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Import failed (${response.status})`);
  return body;
}

async function runFunnyCommand(options, io) {
  const scan = parsePositiveInteger(options.scan, "scan");
  const candidates = parsePositiveInteger(options.candidates, "candidates");

  const history = await readCodexPrompts({
    codexHome: options.codexHome,
    historyPath: options.historyPath,
    limit: scan
  });
  const results = await findFunniestPrompts(history.prompts, {
    top: DEFAULT_FUNNY_TOP,
    candidates,
    model: options.model,
    effort: options.effort
  });

  if (options.json) {
    io.log(
      JSON.stringify(
        results.map(({ rank, score, prompt }) => ({ rank, score, text: prompt.text })),
        null,
        2
      )
    );
    return;
  }

  io.log(
    results
      .map(
        (result) => `${result.rank}. ${result.score}/100\n${result.prompt.text}`
      )
      .join("\n\n")
  );
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
