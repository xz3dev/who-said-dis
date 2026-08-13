const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token, action, remoteIp, config, fetchImpl = fetch) {
  if (config.turnstileBypass) return token === "development-bypass";
  if (!config.turnstileSecretKey || typeof token !== "string" || token.length > 2048) return false;

  try {
    const response = await fetchImpl(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: config.turnstileSecretKey,
        response: token,
        remoteip: remoteIp
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const result = await response.json();
    return (
      result.success === true &&
      result.action === action &&
      (!config.turnstileHostname || result.hostname === config.turnstileHostname)
    );
  } catch {
    return false;
  }
}
