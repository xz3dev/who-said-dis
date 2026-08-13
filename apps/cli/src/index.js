import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_LIMIT = 100;

export {
  DEFAULT_FUNNY_CANDIDATES,
  DEFAULT_FUNNY_EFFORT,
  DEFAULT_FUNNY_MODEL,
  DEFAULT_FUNNY_SCAN,
  DEFAULT_FUNNY_TOP,
  buildFunnyResultSchema,
  buildJudgePrompt,
  findFunniestPrompts,
  isEligiblePrompt,
  scoreHumorSignals,
  selectHumorCandidates
} from "./funny.js";

export { readClaudePrompts, resolveClaudeHome } from "./claude.js";

/**
 * Resolve Codex's data directory without reading any files.
 *
 * Precedence: an explicit value, CODEX_HOME, then ~/.codex.
 */
export function resolveCodexHome(explicitHome) {
  return resolve(explicitHome || process.env.CODEX_HOME || join(homedir(), ".codex"));
}

/**
 * Return recent text prompts from every locally recorded Codex surface.
 *
 * Session rollouts are canonical because they identify their originating client
 * (Desktop, CLI, IDE, exec, and so on). history.jsonl is merged as a fallback
 * for prompts whose session rollout is no longer present.
 */
export async function readCodexPrompts(options = {}) {
  const limit = parseLimit(options.limit ?? DEFAULT_LIMIT);
  const codexHome = resolveCodexHome(options.codexHome);

  if (options.historyPath) {
    const historyPath = resolve(options.historyPath);
    await assertReadable(historyPath, "Codex history");
    const history = await readHistoryFile(historyPath);
    return makeResult(codexHome, [historyPath], history.prompts, history.diagnostics, limit);
  }

  const sessionFiles = [
    ...(await findJsonlFiles(join(codexHome, "sessions"))),
    ...(await findJsonlFiles(join(codexHome, "archived_sessions")))
  ];
  const historyPath = join(codexHome, "history.jsonl");
  const hasHistory = await isReadable(historyPath);

  if (sessionFiles.length === 0 && !hasHistory) {
    throw historyNotFoundError(codexHome);
  }

  const diagnostics = { invalidLines: 0, ignoredLines: 0, unreadableFiles: 0 };
  const sessionPrompts = [];

  for (const file of sessionFiles) {
    try {
      const parsed = await readSessionFile(file);
      sessionPrompts.push(...parsed.prompts);
      mergeDiagnostics(diagnostics, parsed.diagnostics);
    } catch {
      diagnostics.unreadableFiles += 1;
    }
  }

  // Only use history records that are not already represented by a rollout.
  // Timestamp precision differs between the two formats, so compare by second.
  const prompts = [...sessionPrompts];
  const sessionFingerprints = new Set(sessionPrompts.map(promptFingerprint));

  if (hasHistory) {
    const history = await readHistoryFile(historyPath);
    mergeDiagnostics(diagnostics, history.diagnostics);
    for (const prompt of history.prompts) {
      if (!sessionFingerprints.has(promptFingerprint(prompt))) prompts.push(prompt);
    }
  }

  const files = hasHistory ? [...sessionFiles, historyPath] : sessionFiles;
  return makeResult(codexHome, files, prompts, diagnostics, limit);
}

async function readSessionFile(path) {
  const records = [];
  let metadata = null;
  let invalidLines = 0;
  let ignoredLines = 0;
  let lineNumber = 0;

  for await (const line of readLines(path)) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }

    if (record?.type === "session_meta" && isObject(record.payload)) {
      metadata = record.payload;
      continue;
    }

    if (
      record?.type === "event_msg" &&
      record.payload?.type === "user_message" &&
      typeof record.payload.message === "string" &&
      record.payload.message.trim().length > 0
    ) {
      records.push({
        text: record.payload.message,
        timestamp: record.timestamp,
        line: lineNumber
      });
    } else {
      ignoredLines += 1;
    }
  }

  const sessionId =
    stringValue(metadata?.id) ||
    stringValue(metadata?.session_id) ||
    sessionIdFromFilename(path) ||
    "unknown";
  const client = stringValue(metadata?.originator) || "unknown";
  const surface = stringValue(metadata?.source) || "unknown";

  return {
    prompts: records.map((record, index) =>
      createPrompt({
        sessionId,
        ordinal: index + 1,
        timestamp: record.timestamp,
        text: record.text,
        client,
        surface,
        path,
        line: record.line,
        sourceKind: "session"
      })
    ),
    diagnostics: { invalidLines, ignoredLines, unreadableFiles: 0 }
  };
}

async function readHistoryFile(path) {
  const prompts = [];
  const sessionOrdinals = new Map();
  let invalidLines = 0;
  let ignoredLines = 0;
  let lineNumber = 0;

  for await (const line of readLines(path)) {
    lineNumber += 1;
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }

    if (!isHistoryPrompt(record)) {
      ignoredLines += 1;
      continue;
    }

    const ordinal = (sessionOrdinals.get(record.session_id) || 0) + 1;
    sessionOrdinals.set(record.session_id, ordinal);
    prompts.push(
      createPrompt({
        sessionId: record.session_id,
        ordinal,
        timestamp: record.ts,
        text: record.text,
        client: "unknown",
        surface: "history",
        path,
        line: lineNumber,
        sourceKind: "history"
      })
    );
  }

  return { prompts, diagnostics: { invalidLines, ignoredLines, unreadableFiles: 0 } };
}

function createPrompt(input) {
  const digest = createHash("sha256").update(input.text).digest("hex");
  return {
    provider: "codex",
    client: input.client,
    surface: input.surface,
    sessionId: input.sessionId,
    ordinal: input.ordinal,
    timestamp: toIsoTimestamp(input.timestamp),
    text: input.text,
    digest: `sha256:${digest}`,
    citation: `codex://session/${encodeURIComponent(input.sessionId)}/prompt/${input.ordinal}#sha256=${digest}`,
    source: {
      kind: input.sourceKind,
      path: input.path,
      line: input.line
    }
  };
}

function makeResult(codexHome, files, prompts, diagnostics, limit) {
  prompts.sort((left, right) => timestampValue(left.timestamp) - timestampValue(right.timestamp));
  return {
    provider: "codex",
    codexHome,
    files,
    prompts: prompts.slice(-limit),
    diagnostics
  };
}

async function* readLines(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  yield* lines;
}

async function findJsonlFiles(root) {
  const files = [];
  let directory;
  try {
    directory = await opendir(root);
  } catch {
    return files;
  }

  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await findJsonlFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function parseLimit(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  return number;
}

function isHistoryPrompt(value) {
  return (
    isObject(value) &&
    typeof value.session_id === "string" &&
    value.session_id.length > 0 &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    (typeof value.ts === "number" || typeof value.ts === "string")
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

function sessionIdFromFilename(path) {
  return basename(path).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeDiagnostics(target, source) {
  target.invalidLines += source.invalidLines || 0;
  target.ignoredLines += source.ignoredLines || 0;
  target.unreadableFiles += source.unreadableFiles || 0;
}

async function isReadable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertReadable(path, label) {
  if (!(await isReadable(path))) {
    const error = new Error(`${label} not found at ${path}`);
    error.code = "CODEX_HISTORY_NOT_FOUND";
    throw error;
  }
}

function historyNotFoundError(codexHome) {
  const error = new Error(
    `No Codex session records or history found under ${codexHome}. ` +
      "Set CODEX_HOME or pass --codex-home. Local persistence may also be disabled."
  );
  error.code = "CODEX_HISTORY_NOT_FOUND";
  return error;
}
