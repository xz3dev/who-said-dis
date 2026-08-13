#!/usr/bin/env node

import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  if (error?.name === "ExitPromptError") {
    console.log("\nExiting.");
    return;
  }
  console.error(`who-said-dis: ${error.message}`);
  process.exitCode = 1;
});
