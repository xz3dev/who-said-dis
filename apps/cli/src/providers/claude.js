import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudePrompts, resolveClaudeHome } from "../claude.js";
import {
  buildFunnyResultSchema,
  buildJudgePrompt,
  findFunniestPrompts
} from "../funny.js";
import { scanExecutables } from "./executable.js";

export const claudeProvider = {
  id: "claude",
  displayName: "Claude",
  analyzerModel: "haiku",
  analyzerLabel: "Haiku",

  scanInstallations: scanClaudeInstallations,

  async readPrompts(installation, options = {}) {
    const result = await readClaudePrompts({
      claudeHome: installation.dataHome,
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
      judge: (shortlist, judgeOptions) =>
        runClaudeFunnyJudge(shortlist, {
          ...judgeOptions,
          claudeBinary: installation.executablePath,
          claudeHome: installation.dataHome
        })
    });
  }
};

export async function scanClaudeInstallations(options = {}) {
  const environment = options.env || process.env;
  const userHome = options.home || homedir();
  const executables = await scanExecutables("claude", options);
  const dataHome = resolveClaudeHome(
    environment.CLAUDE_CONFIG_DIR || join(userHome, ".claude")
  );

  return executables.map((executablePath) => ({
    providerId: "claude",
    executablePath,
    dataHome,
    label: `claude: ${executablePath}`
  }));
}

export async function runClaudeFunnyJudge(candidates, options) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "who-said-dis-claude-"));
  try {
    const schema = buildFunnyResultSchema(options.top);
    const args = buildClaudeJudgeArgs(schema, options);
    const input = buildJudgePrompt(candidates, options.top);
    const output = await spawnClaude(options.claudeBinary, args, input, temporaryDirectory);

    let response;
    try {
      response = JSON.parse(output);
    } catch {
      throw new Error("Claude returned invalid JSON for the funny ranking");
    }
    const result = response?.structured_output || response;
    if (!Array.isArray(result?.results)) throw new Error("Claude returned an invalid funny ranking");
    return result.results;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function buildClaudeJudgeArgs(schema, options = {}) {
  return [
    "--print",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--model",
    options.model || "haiku",
    "--effort",
    options.effort || "medium",
    "--tools",
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema)
  ];
}

function spawnClaude(binary, args, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Claude funny ranking timed out after 10 minutes")));
    }, 10 * 60 * 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) {
        child.kill("SIGTERM");
        finish(() => reject(new Error("Claude funny ranking returned too much output")));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.on("error", (error) => {
      finish(() => reject(new Error(`Could not run ${binary}: ${error.message}`)));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else {
          const detail = stderr.trim() || claudeTerminalReason(stdout);
          reject(new Error(`Claude exited with code ${code}${detail ? `: ${detail}` : ""}`));
        }
      });
    });
    child.stdin.end(input);
  });
}

function claudeTerminalReason(output) {
  try {
    const response = JSON.parse(output);
    const reason = response?.terminal_reason || response?.stop_reason;
    return typeof reason === "string" ? `terminal reason: ${reason}` : "";
  } catch {
    return "";
  }
}
