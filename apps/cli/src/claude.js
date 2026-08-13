import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export function resolveClaudeHome(explicitHome) {
  return resolve(explicitHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
}

/** Read typed Claude Code prompts while deliberately ignoring pasted attachments. */
export async function readClaudePrompts(options = {}) {
  const limit = parseLimit(options.limit ?? 100);
  const claudeHome = resolveClaudeHome(options.claudeHome);
  const explicitHistoryPath = options.historyPath ? resolve(options.historyPath) : null;
  const historyPath = explicitHistoryPath || join(claudeHome, "history.jsonl");
  const hasHistory = await isReadable(historyPath);
  const transcriptFiles = explicitHistoryPath
    ? []
    : await findTranscriptFiles(join(claudeHome, "projects"));

  if (!hasHistory && transcriptFiles.length === 0) {
    const error = new Error(
      `No Claude history or project transcripts found under ${claudeHome}. ` +
        "Set CLAUDE_CONFIG_DIR or pass claudeHome. Local persistence may also be disabled."
    );
    error.code = "CLAUDE_HISTORY_NOT_FOUND";
    throw error;
  }

  const diagnostics = { invalidLines: 0, ignoredLines: 0, unreadableFiles: 0 };
  const historyPrompts = hasHistory ? await readHistoryFile(historyPath, diagnostics) : [];
  const prompts = [...historyPrompts];
  const fingerprints = new Set(historyPrompts.map(promptFingerprint));

  for (const transcriptPath of transcriptFiles) {
    try {
      const transcriptPrompts = await readTranscriptFile(transcriptPath, diagnostics);
      for (const prompt of transcriptPrompts) {
        const fingerprint = promptFingerprint(prompt);
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        prompts.push(prompt);
      }
    } catch {
      diagnostics.unreadableFiles += 1;
    }
  }

  prompts.sort((left, right) => timestampValue(left.timestamp) - timestampValue(right.timestamp));
  return {
    provider: "claude",
    claudeHome,
    files: [...(hasHistory ? [historyPath] : []), ...transcriptFiles],
    prompts: prompts.slice(-limit),
    diagnostics
  };
}

async function readHistoryFile(path, diagnostics) {
  const prompts = [];
  const sessionOrdinals = new Map();
  let lineNumber = 0;

  for await (const line of readLines(path)) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      diagnostics.invalidLines += 1;
      continue;
    }

    if (!isClaudeHistoryPrompt(record)) {
      diagnostics.ignoredLines += 1;
      continue;
    }

    const sessionId = record.sessionId || "unknown";
    const ordinal = (sessionOrdinals.get(sessionId) || 0) + 1;
    sessionOrdinals.set(sessionId, ordinal);
    prompts.push(
      createClaudePrompt({
        text: record.display,
        timestamp: record.timestamp,
        sessionId,
        ordinal,
        surface: "history",
        sourceKind: "history",
        path,
        line: lineNumber
      })
    );
  }

  return prompts;
}

async function readTranscriptFile(path, diagnostics) {
  const prompts = [];
  const fallbackSessionId = basename(path, ".jsonl") || "unknown";
  let ordinal = 0;
  let lineNumber = 0;

  for await (const line of readLines(path)) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      diagnostics.invalidLines += 1;
      continue;
    }

    if (!isClaudeTranscriptPrompt(record)) {
      diagnostics.ignoredLines += 1;
      continue;
    }

    ordinal += 1;
    prompts.push(
      createClaudePrompt({
        text: record.message.content,
        timestamp: record.timestamp,
        sessionId: record.sessionId || fallbackSessionId,
        ordinal,
        surface: "project",
        sourceKind: "session",
        path,
        line: lineNumber
      })
    );
  }

  return prompts;
}

function createClaudePrompt(input) {
  const digest = createHash("sha256").update(input.text).digest("hex");
  return {
    provider: "claude",
    client: "Claude Code",
    surface: input.surface,
    sessionId: input.sessionId,
    ordinal: input.ordinal,
    timestamp: toIsoTimestamp(input.timestamp),
    text: input.text,
    digest: `sha256:${digest}`,
    citation: `claude://session/${encodeURIComponent(input.sessionId)}/prompt/${input.ordinal}#sha256=${digest}`,
    source: { kind: input.sourceKind, path: input.path, line: input.line }
  };
}

function isClaudeHistoryPrompt(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.display === "string" &&
    value.display.trim().length > 0 &&
    (typeof value.timestamp === "number" || typeof value.timestamp === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string")
  );
}

function isClaudeTranscriptPrompt(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === "user" &&
    value.isMeta !== true &&
    value.message?.role === "user" &&
    typeof value.message.content === "string" &&
    value.message.content.trim().length > 0 &&
    (typeof value.timestamp === "number" || typeof value.timestamp === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string")
  );
}

function toIsoTimestamp(value) {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const numeric = Number(value);
  const milliseconds = Number.isFinite(numeric)
    ? numeric < 10_000_000_000
      ? numeric * 1000
      : numeric
    : NaN;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function promptFingerprint(prompt) {
  const second = Math.floor(timestampValue(prompt.timestamp) / 1000);
  return `${prompt.sessionId}\0${prompt.digest}\0${second}`;
}

function timestampValue(timestamp) {
  const value = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isNaN(value) ? 0 : value;
}

function parseLimit(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  return number;
}

async function* readLines(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  yield* lines;
}

async function findTranscriptFiles(root) {
  const files = [];
  let directory;
  try {
    directory = await opendir(root);
  } catch {
    return files;
  }

  for await (const entry of directory) {
    if (entry.name === "subagents") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await findTranscriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function isReadable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
