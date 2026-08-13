import { resolve } from "node:path";

export function readConfig(environment = process.env) {
  const publicUrl = (environment.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
  const turnstileBypass = environment.TURNSTILE_BYPASS === "1";
  const turnstileSecretKey = environment.TURNSTILE_SECRET_KEY || environment.TURNSTILE_SECRET || "";
  const cliCommand =
    environment.CLI_COMMAND ||
    (environment.NODE_ENV === "production" ? "npx @xz3dev/who-said-dis" : "npm run cli --");
  const voteTimeoutSeconds = parseVoteTimeout(environment.VOTE_TIMEOUT_SECONDS);
  if (!turnstileBypass && (!environment.TURNSTILE_SITE_KEY || !turnstileSecretKey)) {
    throw new Error("TURNSTILE_SITE_KEY and TURNSTILE_SECRET are required");
  }
  return {
    port: Number(environment.PORT || 3000),
    publicUrl,
    cliCommand,
    voteTimeoutSeconds,
    databasePath: resolve(environment.DATABASE_PATH || "data/who-said-dis.sqlite"),
    turnstileSiteKey: environment.TURNSTILE_SITE_KEY || "",
    turnstileSecretKey,
    turnstileHostname: environment.TURNSTILE_HOSTNAME || new URL(publicUrl).hostname,
    turnstileBypass,
    secureCookies: environment.SECURE_COOKIES !== "0" && publicUrl.startsWith("https://"),
    trustProxy: environment.TRUST_PROXY === "1"
  };
}

function parseVoteTimeout(value) {
  const seconds = value === undefined || value === "" ? 45 : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) {
    throw new Error("VOTE_TIMEOUT_SECONDS must be an integer between 1 and 300");
  }
  return seconds;
}
