import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** Find executable installations on PATH and in common user-level locations. */
export async function scanExecutables(command, options = {}) {
  const environment = options.env || process.env;
  const platform = options.platform || process.platform;
  const userHome = options.home || homedir();
  const names = platform === "win32" ? windowsExecutableNames(command, environment) : [command];
  const directories = unique([
    ...(environment.PATH || "").split(delimiter).filter(Boolean),
    join(userHome, ".local", "bin"),
    join(userHome, ".npm-global", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin"
  ]);
  const installations = [];
  const seenTargets = new Set();

  for (const directory of directories) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      if (!(await isExecutable(candidate, platform))) continue;

      let target;
      try {
        target = await realpath(candidate);
      } catch {
        target = candidate;
      }
      if (seenTargets.has(target)) continue;
      seenTargets.add(target);
      installations.push(candidate);
    }
  }

  return installations;
}

function windowsExecutableNames(command, environment) {
  const extensions = (environment.PATHEXT || ".EXE;.CMD;.BAT")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  return unique([command, ...extensions.map((extension) => `${command}${extension}`)]);
}

async function isExecutable(path, platform) {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values)];
}
