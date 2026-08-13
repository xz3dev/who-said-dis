import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { scanCodexInstallations } from "../apps/cli/src/providers/codex.js";
import { providers } from "../apps/cli/src/providers/index.js";

test("Codex scanner finds executable installations on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "who-said-dis-provider-"));
  const bin = join(root, "bin");
  const codexHome = join(root, "codex-home");
  const executable = join(bin, "codex");
  await mkdir(bin);
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);

  const installations = await scanCodexInstallations({
    env: { PATH: [bin].join(delimiter), CODEX_HOME: codexHome },
    home: root,
    platform: process.platform
  });

  assert.equal(installations.length, 1);
  assert.equal(installations[0].label, `codex: ${executable}`);
  assert.equal(installations[0].dataHome, codexHome);
});

test("registers Codex and Claude providers in display order", () => {
  assert.deepEqual(providers.map((provider) => provider.id), ["codex", "claude"]);
});
