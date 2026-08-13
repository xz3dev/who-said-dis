import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";

export const providers = [codexProvider, claudeProvider];

/** Scan every registered provider and preserve provider registration order. */
export async function scanInstallations(registeredProviders = providers) {
  const found = [];
  for (const provider of registeredProviders) {
    const installations = await provider.scanInstallations();
    for (const installation of installations) found.push({ provider, installation });
  }
  return found;
}
