import { checkbox } from "@inquirer/prompts";
import {
  DEFAULT_FUNNY_PROMPT_LIMIT,
  DEFAULT_FUNNY_TOP,
  MAX_FUNNY_PROMPT_LENGTH
} from "./funny.js";
import { providers, scanInstallations } from "./providers/index.js";
import { createSpinner } from "./spinner.js";
import { safeTerminalText } from "./terminal.js";

export async function runInteractiveCli(options = {}) {
  const io = options.io || console;
  const promptApi = options.promptApi || { checkbox };
  const registeredProviders = options.providers || providers;
  const scan = options.scanInstallations || (() => scanInstallations(registeredProviders));
  const spinnerFactory = options.spinnerFactory || ((message) => createSpinner(message, { fallback: io }));

  io.log("Scanning for local LLM installations...");
  const found = await scan();

  if (found.length === 0) {
    io.log("No supported local installations found.");
    return { status: "not-found", selections: [] };
  }

  io.log("\nFound installations (all prompt histories will be used):");
  io.log(
    found.map(({ installation }, index) => `${index + 1}. ${oneLine(installation.label)}`).join("\n")
  );

  const analyzer = selectAnalyzer(found);
  io.log(`\nUsing ${analyzer.provider.displayName} with ${analyzer.provider.analyzerLabel} for analysis.`);

  const spinner = spinnerFactory("Scanning and analyzing prompt history...");
  spinner.start();
  let results;
  try {
    const prompts = await readAllPrompts(found);
    results = await analyzer.provider.analyze(analyzer.installation, prompts, {
      top: DEFAULT_FUNNY_TOP
    });
  } finally {
    spinner.stop();
  }

  if (results.length === 0) {
    io.log("No genuinely funny prompts found.");
    return { status: "empty", selections: [] };
  }

  const selections = await promptApi.checkbox({
    message: "Select the prompts to use (space to toggle, enter to confirm):",
    choices: results.map((result) => ({
      name: oneLine(result.prompt.text),
      value: result.prompt,
      checked: true
    })),
    loop: false
  });

  io.log("\nUsing these:");
  if (selections.length > 0) io.log(formatOrderedPrompts(selections));
  return { status: "complete", selections };
}

/** Prefer Codex/Luna, then Claude/Haiku, regardless of discovery order. */
export function selectAnalyzer(found) {
  return (
    found.find(({ provider }) => provider.id === "codex") ||
    found.find(({ provider }) => provider.id === "claude") ||
    found[0]
  );
}

/** Read every prompt, discard oversized entries, then keep the most recent eligible prompts. */
export async function readAllPrompts(found, options = {}) {
  const limit = options.limit || DEFAULT_FUNNY_PROMPT_LIMIT;
  const dataStores = new Set();
  const prompts = [];
  const seenPrompts = new Set();

  for (const { provider, installation } of found) {
    const dataStore = `${provider.id}\0${installation.dataHome || installation.executablePath}`;
    if (dataStores.has(dataStore)) continue;
    dataStores.add(dataStore);

    const providerPrompts = await provider.readPrompts(installation, { unlimited: true });
    for (const prompt of providerPrompts) {
      if ([...prompt.text].length > MAX_FUNNY_PROMPT_LENGTH) continue;
      const identity =
        prompt.citation ||
        `${prompt.provider || provider.id}\0${prompt.sessionId}\0${prompt.timestamp}\0${prompt.digest || prompt.text}`;
      if (seenPrompts.has(identity)) continue;
      seenPrompts.add(identity);
      prompts.push(prompt);
    }
  }

  prompts.sort((left, right) => timestampValue(left.timestamp) - timestampValue(right.timestamp));
  return prompts.slice(-limit);
}

export function formatOrderedPrompts(prompts) {
  return prompts
    .map((prompt, index) => {
      const indentation = "   ";
      return `${index + 1}. ${safeTerminalText(prompt.text).replace(/\r?\n/g, `\n${indentation}`)}`;
    })
    .join("\n");
}

function oneLine(text) {
  return safeTerminalText(text).replace(/\s+/g, " ").trim();
}

function timestampValue(timestamp) {
  const value = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isNaN(value) ? 0 : value;
}
