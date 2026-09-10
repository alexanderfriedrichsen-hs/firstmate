#!/usr/bin/env node
// Thin dispatcher for the localhost app CLI (app/src/server/cli.ts): runs it
// under tsx without a build step. See the README's "Run the localhost app in
// an isolated home" for setup, commands, and FM_HOME requirements.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const loader = fileURLToPath(
  new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../app/src/server/cli.ts", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["--import", loader, cli, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) {
  process.stderr.write(String(result.error) + "\n");
  process.exitCode = 1;
} else process.exitCode = result.status ?? 1;
