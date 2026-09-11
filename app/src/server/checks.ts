import { joineraTool } from "./joinera-tools.ts";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { atomic } from "./home.ts";
import { captureRevision, fingerprint, git } from "./revisions.ts";
import { now } from "../contracts.ts";
const actor = { kind: "collector" as const, id: "revision-collector" };
export function launchChecks(store: Store, ticketId: string, jobId: string) {
  const t = store.ticket(ticketId, actor);
  if (["completed", "cancelled"].includes(t.status))
    throw new Error("Ticket is closed");
  const workers = store
    .conversations({ kind: "user", id: "checks" })
    .filter(
      (c) => c.ticketId === t.id && c.role === "worker" && c.stage !== "review",
    );
  const worker = workers.at(-1);
  if (!worker || worker.state !== "idle")
    throw new Error("Settle the worker before freezing a revision");
  const project = store.projectForTicket(t);
  if (git(worker.cwd, ["remote", "get-url", "origin"]) !== project.remote)
    throw new Error("Worker repository differs from ticket project");
  const joinera = /joinhandshake[/:]joinera(?:\.git)?$/.test(project.remote);
  if (!joinera && project.id !== "default")
    throw new Error(
      "Native validation commands are not configured for project " + project.id,
    );
  const plan = joinera
    ? ["validation", "review", "ci"]
    : ["validation", "review", "ci"];
  const commands = joinera
    ? [
        {
          name: "validation",
          env: { JOINERA_CHECK_RUNNER: "yarn" },
          executable: joineraTool("draft"),
          args: [
            "gate",
            "--base",
            "origin/main",
            "--test-cmd",
            "NODE_ENV=test yarn test:unit",
            "--no-fetch",
          ],
        },
      ]
    : [
        { name: "install", executable: "npm", args: ["ci"] },
        { name: "typecheck", executable: "npm", args: ["run", "typecheck"] },
        { name: "tests", executable: "npm", args: ["test"] },
        { name: "build", executable: "npm", args: ["run", "build"] },
      ];
  if (joinera) {
    const adapter = fs.readFileSync(commands[0].executable, "utf8");
    if (/bun run (check-types:native|lint:biome)/.test(adapter))
      throw new Error(
        "Joinera adapter still invokes Bun; configure its Yarn compatibility before automated gating",
      );
  }
  const revision = captureRevision(worker.cwd, commands, plan);
  const key = fingerprint(revision);
  const configDir = path.join(store.home, "app", "checks", jobId);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  atomic(
    path.join(configDir, "intent.json"),
    JSON.stringify({
      ticketId,
      revision,
      key,
      leaseHolder: "firstmate-check-" + jobId,
    }),
  );
  const lease = JSON.parse(
    execFileSync(
      "treehouse",
      [
        "get",
        "--lease",
        "--json",
        "--lease-holder",
        "firstmate-check-" + jobId,
      ],
      { cwd: project.source, encoding: "utf8" },
    ),
  );
  const cwd = fs.realpathSync(lease.path);
  if (git(cwd, ["remote", "get-url", "origin"]) !== project.remote)
    throw new Error("Check lease repository mismatch");
  if (git(cwd, ["status", "--porcelain"]))
    throw new Error("Check lease is dirty");
  git(cwd, ["switch", "--detach", revision.head]);
  const config = {
    id: jobId,
    ticketId,
    cwd,
    home: store.home,
    revision: key,
    revisionFacts: revision,
    commands,
    lease: { ...lease, source: project.source, remote: project.remote },
    project,
  };
  atomic(path.join(configDir, "config.json"), JSON.stringify(config));
  store.command(actor, {
    commandId: randomUUID(),
    type: "ticket.revision",
    targetId: t.id,
    expectedVersion: t.version,
    payload: { revision: key },
  });
  store.setting("revision:" + key, revision);
  store.setting("revision-source:" + key, {
    cwd: worker.cwd,
    conversationId: worker.id,
  });
  store.setting("check:" + jobId, { ...config, state: "running" });
  const log = fs.openSync(path.join(configDir, "runner.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./check-runner.ts", import.meta.url)),
      path.join(configDir, "config.json"),
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, FM_HOME: store.home },
    },
  );
  child.unref();
  fs.closeSync(log);
  store.event("check.started", ticketId, { jobId, revision: key }, ticketId);
}
export function collectChecks(store: Store) {
  const rows = store.db
    .prepare("SELECT key,value FROM settings WHERE key LIKE 'check:%'")
    .all() as any[];
  for (const row of rows) {
    const job = JSON.parse(row.value);
    if (job.state !== "running") continue;
    const dir = path.join(store.home, "app", "checks", job.id);
    const resultFile = path.join(dir, "result.json");
    if (!fs.existsSync(resultFile)) continue;
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (result.id !== job.id || result.revision !== job.revision)
      throw new Error("Check result provenance differs from dispatch");
    const t = store.ticket(job.ticketId, actor);
    const dirty = git(job.cwd, ["status", "--porcelain"]);
    const head = git(job.cwd, ["rev-parse", "HEAD"]);
    const passed = result.passed && !dirty && head === job.revisionFacts.head;
    const artifactId = store.artifact(
      t.id,
      "validation-result.json",
      JSON.stringify({ ...result, lease: job.lease, dirty, head }, null, 2),
      "application/json",
    );
    store.db.transaction(() => {
      store.command(actor, {
        commandId: randomUUID(),
        type: "evidence.register",
        targetId: t.id,
        expectedVersion: t.version,
        payload: {
          revision: job.revision,
          requirement: "validation",
          verdict: passed ? "passed" : "failed",
          provenance: "isolated-check-runner:" + job.id,
          artifactId,
        },
      });
      store.setting(row.key, {
        ...job,
        state: passed ? "passed" : "failed",
        artifactId,
      });
      store.db.prepare("INSERT OR IGNORE INTO wakes VALUES(?,?,?,?,?)").run(
        "check:" + job.id,
        t.id,
        "pending",
        JSON.stringify({
          kind: "check.finished",
          jobId: job.id,
          passed,
          artifactId,
        }),
        now(),
      );
    })();
  }
}
