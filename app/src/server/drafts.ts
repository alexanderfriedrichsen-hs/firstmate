import { joineraTool } from "./joinera-tools.ts";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { git } from "./revisions.ts";
import { atomic } from "./home.ts";
import { now } from "../contracts.ts";
const run = promisify(execFile);
const actor = { kind: "collector" as const, id: "draft-collector" };
export function assertDraftCurrent(
  store: Store,
  ticketId: string,
  revision: string,
  commandId: string,
) {
  store.assertOwner();
  const current = store.ticket(ticketId, {
    kind: "user",
    id: "draft-state-check",
  });
  if (
    current.handling !== "agent_managed" ||
    ["completed", "cancelled"].includes(current.status) ||
    current.revision !== revision ||
    store.setting("writerReservation:" + ticketId)?.commandId !== commandId
  )
    throw new Error(
      "Draft ticket lifecycle, revision, or writer reservation changed",
    );
  return current;
}
export async function launchDraft(store: Store, job: any) {
  const t = store.ticket(job.target_id, actor);
  const p = JSON.parse(job.payload);
  const project = store.projectForTicket(t);
  if (!/joinhandshake[/:]joinera(?:\.git)?$/.test(project?.remote ?? ""))
    throw new Error("Draft adapter supports Joinera only");
  const facts = store.setting("revision:" + t.revision);
  const source = store.setting("revision-source:" + t.revision);
  if (!facts || !source)
    throw new Error("Freeze and validate a revision first");
  const worker = store.conversation(source.conversationId, actor);
  if (git(source.cwd, ["remote", "get-url", "origin"]) !== project.remote)
    throw new Error("Draft source repository differs from ticket project");
  if (
    worker.state !== "idle" ||
    git(source.cwd, ["status", "--porcelain"]) ||
    git(source.cwd, ["rev-parse", "HEAD"]) !== facts.head ||
    git(source.cwd, ["rev-parse", "origin/main"]) !== facts.base
  )
    throw new Error("Source worker or revision changed before draft creation");
  const validation = store
    .evidence(t.id)
    .filter((e) => e.revision === t.revision && e.requirement === "validation")
    .at(-1);
  if (validation?.verdict !== "passed")
    throw new Error("Current independent validation must pass first");
  const branch = git(source.cwd, ["branch", "--show-current"]);
  if (!branch || branch === "main")
    throw new Error("A dedicated work branch is required");
  const existing = JSON.parse(
    (
      await run(
        "gh",
        [
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "open",
          "--json",
          "url,isDraft",
        ],
        { cwd: source.cwd, encoding: "utf8", timeout: 30000 },
      )
    ).stdout,
  );
  store.assertOwner();
  if (existing.some((pr: any) => !pr.isDraft))
    throw new Error(
      "This branch already has a non-draft PR; an explicit follow-up action is required",
    );
  assertDraftCurrent(store, t.id, t.revision!, job.command_id);
  const dir = path.join(store.home, "app", "drafts", job.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bodyFile = path.join(dir, "body.md");
  atomic(bodyFile, p.body);
  const config = {
    id: job.id,
    ticketId: t.id,
    cwd: source.cwd,
    revision: t.revision,
    head: facts.head,
    branch,
    home: store.home,
    commands: [
      {
        name: "draft",
        executable: joineraTool("draft"),
        args: [
          "create-draft-pr",
          "--title",
          p.title,
          "--body-file",
          bodyFile,
          "--run-gate",
          "--test-cmd",
          "NODE_ENV=test yarn test:unit",
        ],
        env: { JOINERA_CHECK_RUNNER: "yarn" },
      },
    ],
  };
  atomic(path.join(dir, "config.json"), JSON.stringify(config));
  store.setting("draft:" + job.id, {
    ...config,
    state: "running",
    commandId: job.command_id,
  });
  const log = fs.openSync(path.join(dir, "runner.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./check-runner.ts", import.meta.url)),
      path.join(dir, "config.json"),
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    },
  );
  child.unref();
  fs.closeSync(log);
  store.event(
    "draft.started",
    t.id,
    { jobId: job.id, revision: t.revision },
    t.id,
  );
}
export async function collectDraft(store: Store, key: string) {
  const job = store.setting(key);
  const dir = path.join(store.home, "app", "drafts", job.id);
  const result = JSON.parse(
    fs.readFileSync(path.join(dir, "result.json"), "utf8"),
  );
  if (result.id !== job.id || result.revision !== job.revision)
    throw new Error("Draft result identity differs from dispatch");
  const artifactId = store.artifact(
    job.ticketId,
    "draft-result.json",
    JSON.stringify(
      { result, log: fs.readFileSync(path.join(dir, "draft.log"), "utf8") },
      null,
      2,
    ),
    "application/json",
  );
  if (!result.passed) {
    store.setting(key, { ...job, state: "needs_reconciliation", artifactId });
    store.event(
      "draft.needsReconciliation",
      job.ticketId,
      { jobId: job.id, artifactId },
      job.ticketId,
    );
    return;
  }
  const pr = JSON.parse(
    (
      await run(
        "gh",
        ["pr", "view", job.branch, "--json", "url,isDraft,headRefOid"],
        { cwd: job.cwd, encoding: "utf8", timeout: 30000 },
      )
    ).stdout,
  );
  store.assertOwner();
  if (!pr.isDraft || pr.headRefOid !== job.head)
    throw new Error("Remote PR differs from the expected draft revision");
  const t = assertDraftCurrent(
    store,
    job.ticketId,
    job.revision,
    job.commandId,
  );
  store.command(
    { kind: "user", id: "verified-draft-adapter" },
    {
      commandId: randomUUID(),
      type: "ticket.update",
      targetId: t.id,
      expectedVersion: t.version,
      payload: {
        links: [
          ...t.links.filter((l) => l.url !== pr.url),
          { kind: "github_pr", url: pr.url },
        ],
      },
    },
  );
  store.setting(key, {
    ...job,
    state: "completed",
    artifactId,
    url: pr.url,
    completedAt: now(),
  });
  store.setting("writerReservation:" + t.id, null);
  store.event(
    "draft.created",
    t.id,
    { url: pr.url, head: pr.headRefOid, artifactId },
    t.id,
  );
}
