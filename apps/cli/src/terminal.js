import { stripVTControlCharacters } from "node:util";

/** Remove terminal control sequences from text before writing human-readable output. */
export function safeTerminalText(value) {
  return stripVTControlCharacters(String(value)).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
    ""
  );
}
