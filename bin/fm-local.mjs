#!/usr/bin/env node
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
