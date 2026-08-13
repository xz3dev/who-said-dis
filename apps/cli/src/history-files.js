import { createReadStream } from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";

export const MAX_HISTORY_FILES = 5_000;
export const MAX_HISTORY_ENTRIES = 50_000;
export const MAX_HISTORY_LINE_LENGTH = 16_384;
export const MAX_PROMPT_SCAN = 10_000;
export const MAX_TRACKED_SESSIONS = 20_000;

/** Recursively discover a bounded number of JSONL files without following symlinks. */
export async function findJsonlFiles(root, options = {}) {
  const files = [];
  const maxFiles = options.maxFiles || MAX_HISTORY_FILES;
  const maxEntries = options.maxEntries || MAX_HISTORY_ENTRIES;
  let entriesVisited = 0;

  async function visit(directoryPath) {
    if (files.length >= maxFiles || entriesVisited >= maxEntries) return;
    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch {
      return;
    }

    for await (const entry of directory) {
      entriesVisited += 1;
      if (files.length >= maxFiles || entriesVisited > maxEntries) break;
      if (entry.isDirectory()) {
        if (!options.skipDirectory?.(entry.name)) await visit(join(directoryPath, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(join(directoryPath, entry.name));
      }
    }
  }

  await visit(root);
  return files;
}

/** Stream lines while discarding any individual line that exceeds the configured bound. */
export async function* readBoundedLines(path, maxLineLength = MAX_HISTORY_LINE_LENGTH) {
  const input = createReadStream(path, { encoding: "utf8" });
  let pending = "";
  let discarding = false;

  for await (const chunk of input) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf("\n", cursor);
      const end = newline === -1 ? chunk.length : newline;
      if (!discarding) {
        pending += chunk.slice(cursor, end);
        if (pending.length > maxLineLength) {
          pending = "";
          discarding = true;
        }
      }

      if (newline === -1) break;
      if (discarding) yield null;
      else yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      pending = "";
      discarding = false;
      cursor = newline + 1;
    }
  }

  if (discarding) yield null;
  else if (pending) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
}

/** Keep arrays bounded while preserving their most recently appended values. */
export function trimRecent(values, limit, compare) {
  if (values.length > limit * 2) {
    if (compare) values.sort(compare);
    values.splice(0, values.length - limit);
  }
  return values;
}

/** Track session-local ordinals without allowing attacker-controlled IDs to grow a Map forever. */
export function nextBoundedOrdinal(ordinals, sessionId, fallback) {
  const current = ordinals.get(sessionId);
  if (current !== undefined) {
    ordinals.set(sessionId, current + 1);
    return current + 1;
  }
  if (ordinals.size >= MAX_TRACKED_SESSIONS) return fallback;
  ordinals.set(sessionId, 1);
  return 1;
}
