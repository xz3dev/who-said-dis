#!/usr/bin/env node

import { runCli } from "../src/cli.js";
import { safeTerminalText } from "../src/terminal.js";

runCli(process.argv.slice(2)).catch((error) => {
  if (error?.name === "ExitPromptError") {
    console.log("\nExiting.");
    return;
  }
  console.error(`who-said-dis: ${safeTerminalText(error.message)}`);
  process.exitCode = 1;
});
