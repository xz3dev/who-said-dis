export const MAX_NAME_LENGTH = 32;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ROOM_PARTICIPANTS = 20;
export const MAX_PROMPTS_PER_IMPORT = 5;
export const MAX_PROMPT_LENGTH = 400;
export const MAX_ANSWER_OPTIONS = 4;
export const IMPORT_TOKEN_TTL_MS = 30 * 60 * 1000;

export function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim().replace(/\s+/g, " ");
  const unsafeControls = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && !unsafeControls.test(name)
    ? name
    : null;
}
