export const MAX_NAME_LENGTH = 32;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ROOM_PARTICIPANTS = 20;
export const MAX_PROMPTS_PER_IMPORT = 5;
export const MAX_PROMPT_LENGTH = 400;
export const MAX_ANSWER_OPTIONS = 4;

export function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}
