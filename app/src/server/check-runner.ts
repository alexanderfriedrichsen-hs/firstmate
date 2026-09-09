import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomic, processIdentity } from "./home.ts";
const configFile = process.argv[2];
const dir = path.dirname(configFile);
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
atomic(
  path.join(dir, "identity.json"),
  JSON.stringify({
    pid: process.pid,
    startIdentity: processIdentity(),
    jobId: config.id,
  }),
);
const results = [];
for (const check of config.commands) {
  const startedAt = new Date().toISOString();
  const log = fs.openSync(path.join(dir, check.name + ".log"), "a", 0o600);
  const exit = await new Promise<number | null>((resolve) => {
    const child = spawn(check.executable, check.args, {
      cwd: config.cwd,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        ...check.env,
        FM_HOME: undefined,
        FM_AGENT_TOKEN_FILE: undefined,
      },
    });
    child.on("error", (e) => {
      fs.writeSync(log, String(e));
      resolve(null);
    });
    child.on("exit", (code) => resolve(code));
  });
  fs.fsyncSync(log);
  fs.closeSync(log);
  results.push({
    name: check.name,
    executable: check.executable,
    args: check.args,
    exit,
    startedAt,
    endedAt: new Date().toISOString(),
  });
  if (exit !== 0) break;
}
atomic(
  path.join(dir, "result.json"),
  JSON.stringify({
    id: config.id,
    revision: config.revision,
    results,
    passed:
      results.length === config.commands.length &&
      results.every((r) => r.exit === 0),
    endedAt: new Date().toISOString(),
  }),
);
