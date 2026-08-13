import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_FUNNY_EFFORT,
  DEFAULT_FUNNY_MODEL,
  DEFAULT_FUNNY_PROMPT_LIMIT,
  DEFAULT_FUNNY_TOP,
  DEFAULT_LIMIT,
  findFunniestPrompts,
  readCodexPrompts
} from "./index.js";
import { runInteractiveCli } from "./interactive.js";
import { safeTerminalText } from "./terminal.js";

const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

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
    const fetchImpl = dependencies.fetchImpl || fetch;
    const verified = await verifyImportToken(options.room, options.token, fetchImpl);
    io.log(`Import code verified for ${safeTerminalText(verified.name)}.`);
    const result = await runInteractiveCli({ io, ...dependencies });
    if (result.status !== "complete" || result.selections.length === 0) {
      io.log("No prompts imported.");
      return;
    }
    const imported = await uploadPrompts(
      options.room,
      options.token,
      result.selections,
      fetchImpl
    );
    io.log(`\nImported ${imported.imported} prompt${imported.imported === 1 ? "" : "s"} for ${safeTerminalText(imported.name)}.`);
    return;
  }

  if (options.command === "funny") {
    await runFunnyCommand(options, io);
    return;
  }

  const result = await readCodexPrompts(options);

  if (options.json) {
    io.log(terminalSafeJson(result.prompts));
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
        top: DEFAULT_FUNNY_TOP,
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
        options.token = requiredImportToken(args, ++index);
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

function requiredImportToken(args, index) {
  const value = args[index];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(value)) {
    throw new Error("The import code is invalid");
  }
  return value;
}

function formatPrompt(prompt, displayIndex) {
  const origin = safeTerminalText(prompt.client === "unknown" ? prompt.surface : prompt.client);
  const header = `${displayIndex}. ${safeTerminalText(prompt.timestamp || "unknown time")} · ${origin} · ${safeTerminalText(prompt.sessionId)}`;
  return `${header}\n${safeTerminalText(prompt.text)}\n${safeTerminalText(prompt.citation)}`;
}

function helpText() {
  return `who-said-dis — interactively discover and analyze local LLM prompt history

Usage:
  who-said-dis                 Start the interactive wizard
  who-said-dis import --room <url> --token <one-time-token>
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
      --model <model>       Codex judge model (default: gpt-5.6-luna)
      --effort <effort>     Reasoning effort (default: medium)

Reading is local and read-only. The funny command sends the 700 most recent prompts
through your authenticated Codex CLI connection for model inference.`;
}

export async function uploadPrompts(roomUrl, token, prompts, fetchImpl = fetch) {
  const { origin, roomId } = parseImportTarget(roomUrl, token);
  const response = await fetchImpl(`${origin}/api/rooms/${roomId}/prompts`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
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

export async function verifyImportToken(roomUrl, token, fetchImpl = fetch) {
  const { origin, roomId } = parseImportTarget(roomUrl, token);
  const response = await fetchImpl(`${origin}/api/rooms/${roomId}/import-token/verify`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.valid !== true) {
    throw new Error(body.error || `Import-code verification failed (${response.status})`);
  }
  return body;
}

function parseImportTarget(roomUrl, token) {
  let url;
  try {
    url = new URL(roomUrl);
  } catch {
    throw new Error("--room must be a valid room URL");
  }
  const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{12})\/?$/);
  if (!match || !/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("--room must be a valid room URL");
  }
  if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("--room must use HTTPS unless it points to localhost");
  }
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    throw new Error("The import code is invalid");
  }
  return { origin: url.origin, roomId: match[1] };
}

async function runFunnyCommand(options, io) {
  const history = await readCodexPrompts({
    codexHome: options.codexHome,
    historyPath: options.historyPath,
    limit: DEFAULT_FUNNY_PROMPT_LIMIT
  });
  const results = await findFunniestPrompts(history.prompts, {
    top: DEFAULT_FUNNY_TOP,
    model: options.model,
    effort: options.effort
  });

  if (options.json) {
    io.log(
      terminalSafeJson(
        results.map(({ rank, score, prompt }) => ({ rank, score, text: prompt.text }))
      )
    );
    return;
  }

  io.log(
    results
      .map(
        (result) => `${result.rank}. ${result.score}/100\n${safeTerminalText(result.prompt.text)}`
      )
      .join("\n\n")
  );
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const version = isIP(normalized);
  if (version === 4) return normalized.startsWith("127.");
  return version === 6 && normalized === "::1";
}

function terminalSafeJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`
  );
}
