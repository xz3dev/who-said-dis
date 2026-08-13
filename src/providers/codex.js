import { homedir } from "node:os";
import { join } from "node:path";
import { findFunniestPrompts } from "../funny.js";
import { readCodexPrompts, resolveCodexHome } from "../index.js";
import { scanExecutables } from "./executable.js";

export const codexProvider = {
  id: "codex",
  displayName: "Codex",
  analyzerModel: "gpt-5.6-luna",
  analyzerLabel: "Luna",

  scanInstallations: scanCodexInstallations,

  async readPrompts(installation, options = {}) {
    const result = await readCodexPrompts({
      codexHome: installation.dataHome,
      limit: options.limit
    });
    return result.prompts;
  },

  async analyze(installation, prompts, options = {}) {
    return findFunniestPrompts(prompts, {
      top: options.top,
      candidates: options.candidates,
      model: this.analyzerModel,
      effort: "medium",
      codexBinary: installation.executablePath
    });
  }
};

/** Locate executable Codex installations without invoking them. */
export async function scanCodexInstallations(options = {}) {
  const environment = options.env || process.env;
  const userHome = options.home || homedir();
  const executables = await scanExecutables("codex", options);

  return executables.map((executablePath) =>
    ({
      providerId: "codex",
      executablePath,
      dataHome: resolveCodexHome(environment.CODEX_HOME || join(userHome, ".codex")),
      label: `codex: ${executablePath}`
    })
  );
}
