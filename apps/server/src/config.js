import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

const packageVersion = JSON.parse(
  readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8")
).version;

export function readConfig(environment = process.env) {
  const parsedPublicUrl = new URL(environment.PUBLIC_URL || "http://localhost:3000");
  if (
    parsedPublicUrl.username ||
    parsedPublicUrl.password ||
    parsedPublicUrl.pathname !== "/" ||
    parsedPublicUrl.search ||
    parsedPublicUrl.hash ||
    !["http:", "https:"].includes(parsedPublicUrl.protocol)
  ) {
    throw new Error("PUBLIC_URL must be an HTTP(S) origin without credentials, a path, query, or fragment");
  }
  const publicUrl = parsedPublicUrl.origin;
  const turnstileBypass = environment.TURNSTILE_BYPASS === "1";
  const turnstileSecretKey = environment.TURNSTILE_SECRET_KEY || environment.TURNSTILE_SECRET || "";
  const cliCommand =
    environment.CLI_COMMAND ||
    (environment.NODE_ENV === "production"
      ? `npx --yes @xz3dev/who-said-dis@${packageVersion}`
      : "npm run cli --");
  const voteTimeoutSeconds = parseVoteTimeout(environment.VOTE_TIMEOUT_SECONDS);
  const port = parsePort(environment.PORT);
  const trustProxy = environment.TRUST_PROXY === "1";
  const trustedProxyAddresses = parseTrustedProxyAddresses(environment.TRUSTED_PROXY_IPS);
  const legal = readLegalDetails(environment);
  if (environment.NODE_ENV === "production" && turnstileBypass) {
    throw new Error("TURNSTILE_BYPASS cannot be enabled in production");
  }
  if (environment.NODE_ENV === "production" && parsedPublicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_URL must use HTTPS in production");
  }
  if (environment.NODE_ENV === "production" && environment.SECURE_COOKIES === "0") {
    throw new Error("SECURE_COOKIES cannot be disabled in production");
  }
  if (trustProxy && trustedProxyAddresses.length === 0) {
    throw new Error("TRUSTED_PROXY_IPS is required when TRUST_PROXY=1");
  }
  if (environment.NODE_ENV === "production" && (!legal.name || !legal.address || !legal.email)) {
    throw new Error("LEGAL_NAME, LEGAL_ADDRESS, and LEGAL_EMAIL are required in production");
  }
  if (!turnstileBypass && (!environment.TURNSTILE_SITE_KEY || !turnstileSecretKey)) {
    throw new Error("TURNSTILE_SITE_KEY and TURNSTILE_SECRET are required");
  }
  return {
    port,
    publicUrl,
    cliCommand,
    voteTimeoutSeconds,
    databasePath: resolve(environment.DATABASE_PATH || "data/who-said-dis.sqlite"),
    turnstileSiteKey: environment.TURNSTILE_SITE_KEY || "",
    turnstileSecretKey,
    turnstileHostname: environment.TURNSTILE_HOSTNAME || parsedPublicUrl.hostname,
    turnstileBypass,
    secureCookies: environment.SECURE_COOKIES !== "0" && publicUrl.startsWith("https://"),
    trustProxy,
    trustedProxyAddresses,
    legal
  };
}

function readLegalDetails(environment) {
  const legal = {
    name: legalValue(environment.LEGAL_NAME),
    address: legalValue(environment.LEGAL_ADDRESS),
    email: legalValue(environment.LEGAL_EMAIL),
    representative: legalValue(environment.LEGAL_REPRESENTATIVE),
    register: legalValue(environment.LEGAL_REGISTER),
    registrationNumber: legalValue(environment.LEGAL_REGISTRATION_NUMBER)
  };
  if (legal.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(legal.email)) {
    throw new Error("LEGAL_EMAIL must be a valid email address");
  }
  if (Boolean(legal.register) !== Boolean(legal.registrationNumber)) {
    throw new Error("LEGAL_REGISTER and LEGAL_REGISTRATION_NUMBER must be provided together");
  }
  return legal;
}

function legalValue(value) {
  const normalized = String(value || "").trim();
  if (normalized.length > 500) throw new Error("Legal contact values must not exceed 500 characters");
  return normalized;
}

function parsePort(value) {
  const port = value === undefined || value === "" ? 3000 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseTrustedProxyAddresses(value = "") {
  const addresses = String(value).split(",").map((item) => normalizeIp(item.trim())).filter(Boolean);
  if (addresses.some((address) => isIP(address) === 0)) {
    throw new Error("TRUSTED_PROXY_IPS must contain comma-separated IP addresses");
  }
  return [...new Set(addresses)];
}

function normalizeIp(value) {
  return value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

function parseVoteTimeout(value) {
  const seconds = value === undefined || value === "" ? 45 : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) {
    throw new Error("VOTE_TIMEOUT_SECONDS must be an integer between 1 and 300");
  }
  return seconds;
}
