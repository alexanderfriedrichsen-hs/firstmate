import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath, ownHome } from "../src/server/home.ts";
const user = { kind: "user" as const, id: "test" };
const agent = { kind: "supervisor" as const, id: "supervisor" };
function fixture() {
  const home = homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-test-")));
  const store = new Store(home);
  store.fence();
  return store;
}
function create(s: Store, p: any = {}) {
  return s.command(user, {
    commandId: randomUUID(),
    type: "ticket.create",
    payload: { title: "Test ticket", ...p },
  }).ticket;
}
test("command acceptance survives restart and duplicate submission", () => {
  const s = fixture();
  const cmd = {
    commandId: randomUUID(),
    type: "ticket.create",
    payload: { title: "Once" },
  };
  const first = s.command(user, cmd);
  s.db.close();
  const next = new Store(s.home);
  next.fence();
  assert.equal(next.command(user, cmd).ticket.id, first.ticket.id);
  assert.equal(next.tickets(user).length, 1);
  assert.throws(
    () => next.command(user, { ...cmd, payload: { title: "Changed" } }),
    /reused/,
  );
  next.db.close();
});
test("human-only guessed IDs, aggregates, events, and mutations are denied", () => {
  const s = fixture();
  const t = create(s, { handling: "human_only", title: "Private sentinel" });
  assert.deepEqual(s.tickets(agent), []);
  assert.throws(() => s.ticket(t.id, agent), /not found/);
  assert.equal(
    JSON.stringify(s.events(agent)).includes("Private sentinel"),
    false,
  );
  assert.throws(
    () =>
      s.command(agent, {
        commandId: randomUUID(),
        type: "ticket.update",
        targetId: t.id,
        expectedVersion: 1,
        payload: { title: "leak" },
      }),
    /not found/,
  );
  assert.throws(
    () =>
      s.command(agent, {
        commandId: randomUUID(),
        type: "ticket.create",
        payload: { title: "x", handling: "human_only" },
      }),
    /not found/,
  );
  s.db.close();
});
test("manual completion preserves truthful history and handling on reopen", () => {
  const s = fixture();
  const t = create(s, { handling: "human_only" });
  const closed = s.command(user, {
    commandId: randomUUID(),
    type: "ticket.complete",
    targetId: t.id,
    expectedVersion: t.version,
    payload: {},
  }).ticket;
  assert.equal(closed.status, "completed");
  const detail = s.detail(t.id, user);
  assert.equal(detail.closures[0].source, "manual");
  assert.deepEqual(detail.evidence, []);
  const reopened = s.command(user, {
    commandId: randomUUID(),
    type: "ticket.reopen",
    targetId: t.id,
    expectedVersion: closed.version,
    payload: {},
  }).ticket;
  assert.equal(reopened.handling, "human_only");
  assert.equal(s.detail(t.id, user).closures.length, 1);
  s.db.close();
});
test("stale evidence cannot complete a changed revision", () => {
  const s = fixture();
  let t = create(s, { kind: "investigation" });
  const mutate = (type: string, payload: any, actor: any = user) => {
    t = s.command(actor, {
      commandId: randomUUID(),
      type,
      targetId: t.id,
      expectedVersion: t.version,
      payload,
    }).ticket;
  };
  mutate("ticket.revision", { revision: "report-v1" });
  mutate(
    "evidence.register",
    {
      revision: "report-v1",
      requirement: "report",
      verdict: "passed",
      provenance: "fixture collector",
    },
    { kind: "collector", id: "fixture" },
  );
  assert.equal(t.status, "awaiting_decision");
  mutate("ticket.revision", { revision: "report-v2" });
  assert.throws(
    () => mutate("ticket.claimComplete", { rationale: "Done" }, agent),
    /lacks required/,
  );
  assert.equal(s.evidence(t.id).length, 1);
  s.db.close();
});
test("stale optimistic updates and runtime generations fail closed", () => {
  const s = fixture();
  const t = create(s);
  assert.throws(
    () =>
      s.command(user, {
        commandId: randomUUID(),
        type: "ticket.complete",
        targetId: t.id,
        expectedVersion: 0,
        payload: {},
      }),
    /changed/,
  );
  s.setting("generation", s.generation + 1);
  assert.throws(() => create(s), /generation/);
  s.db.close();
});
test("ownership uses an OS advisory lock and live-home paths are rejected", () => {
  const home = homePath(
    fs.mkdtempSync(path.join(os.tmpdir(), "fm-lock-test-")),
  );
  const release = ownHome(home);
  assert.throws(() => ownHome(home), /Another runtime/);
  release();
  ownHome(home)();
  assert.throws(() => homePath(path.join(os.homedir(), ".firstmate")), /live/);
});
test("invalid link hosts and script URLs fail before insertion", () => {
  const s = fixture();
  for (const url of [
    "javascript:alert(1)",
    "https://github.com.evil.test/a/b/pull/1",
  ])
    assert.throws(() => create(s, { links: [{ kind: "github_pr", url }] }));
  assert.equal(s.tickets(user).length, 0);
  s.db.close();
});
import { retryDecision } from "../src/server/revisions.ts";
import { importLegacy, rollbackExport } from "../src/server/migration.ts";
test("retries stop on ambiguity, live writers, deterministic errors, and exhaustion", () => {
  const base = {
    errorClass: "service_unavailable",
    ordinal: 1,
    elapsedMs: 500,
    allowance: true,
    writerAlive: false,
    uncertain: false,
    random: 0.5,
  };
  assert.equal(retryDecision(base).delayMs, 30000);
  for (const override of [
    { uncertain: true },
    { writerAlive: true },
    { allowance: false },
    { ordinal: 3 },
    { errorClass: "test_failure" },
  ])
    assert.equal(retryDecision({ ...base, ...override }).eligible, false);
  assert.equal(
    retryDecision({ ...base, ordinal: 2, retryAfterMs: 300000 }).delayMs,
    300000,
  );
});
test("shadow import is idempotent and rollback keeps private work out of agent exports", async () => {
  const s = fixture();
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "fm-legacy-"));
  fs.mkdirSync(path.join(source, "data"));
  fs.mkdirSync(path.join(source, "state"));
  fs.writeFileSync(
    path.join(source, "data/backlog.md"),
    "## Done\n- old-task-a1: shipped previously\n## Queued\n- freeform thing\n",
  );
  fs.writeFileSync(
    path.join(source, "state/old-task-a1.meta"),
    "worktree=/fixture\nkind=scout\n",
  );
  const first = importLegacy(s, source);
  assert.equal(first.imported, 2);
  assert.equal(importLegacy(s, source).imported, 0);
  create(s, { title: "SECRET HUMAN SENTINEL", handling: "human_only" });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "fm-rollback-"));
  await rollbackExport(s, output);
  assert.equal(
    fs
      .readFileSync(path.join(output, "managed.json"), "utf8")
      .includes("SECRET HUMAN SENTINEL"),
    false,
  );
  assert.equal(
    fs
      .readFileSync(path.join(output, "backlog.md"), "utf8")
      .includes("SECRET HUMAN SENTINEL"),
    false,
  );
  assert.match(
    fs.readFileSync(path.join(output, "human-only.json"), "utf8"),
    /SECRET HUMAN SENTINEL/,
  );
  s.db.close();
});
import { codexDelta, claudeUsage } from "../src/server/usage.ts";
test("provider cache accounting follows disjoint versus included token semantics", () => {
  assert.deepEqual(
    codexDelta(
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 100, outputTokens: 20 },
    ),
    { input: 0, output: 0 },
  );
  const [row] = claudeUsage(
    {
      modelUsage: {
        "actual-model": {
          inputTokens: 3,
          outputTokens: 12,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 300,
        },
      },
    },
    "requested-model",
  );
  assert.equal(row.model, "actual-model");
  assert.equal(row.input, 323);
  assert.equal(row.output, 12);
  assert.equal(claudeUsage({}, "unknown")[0].input, null);
});
import { Runtime } from "../src/server/runtime.ts";
test("a hidden event burst does not starve later visible events", () => {
  const s = fixture();
  const hidden = create(s, { handling: "human_only" });
  for (let i = 0; i < 1100; i++)
    s.event("private.change", hidden.id, { text: "hidden" }, hidden.id);
  const managed = create(s, { title: "Visible after hidden burst" });
  assert.ok(s.events(agent).some((e) => e.aggregateId === managed.id));
  s.db.close();
});
test("manual and automatic retries reserve one attempt and cancel the losing schedule", async () => {
  const s = fixture();
  const t = create(s);
  const cid = randomUUID();
  s.putConversation({
    id: cid,
    ticketId: t.id,
    provider: "codex",
    model: "fixture",
    role: "worker",
    cwd: s.home,
    incarnation: 1,
    state: "failed",
    inputOwner: "automation",
    version: 1,
  });
  s.putAttempt({
    id: randomUUID(),
    ticketId: t.id,
    conversationId: cid,
    role: "implement",
    state: "failed",
    ordinal: 1,
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });
  const scheduleId = randomUUID();
  s.db
    .prepare("INSERT INTO retries VALUES(?,?,?,?,?,?,?)")
    .run(
      scheduleId,
      t.id,
      null,
      "implement",
      "scheduled",
      new Date(0).toISOString(),
      "{}",
    );
  const runtime = new Runtime(s);
  s.setting("policy", { ...s.setting("policy"), paused: false });
  const manual = s.command(user, {
    commandId: randomUUID(),
    type: "stage.retry",
    targetId: t.id,
    expectedVersion: t.version,
    payload: { stage: "implement" },
  });
  runtime.scheduleRetries();
  assert.equal(
    (
      s.db
        .prepare("SELECT count(*) n FROM outbox WHERE kind='stage.retry'")
        .get() as any
    ).n,
    1,
  );
  assert.equal(
    (
      s.db
        .prepare("SELECT state FROM retries WHERE id=?")
        .get(scheduleId) as any
    ).state,
    "cancelled",
  );
  assert.throws(
    () =>
      s.command(user, {
        commandId: randomUUID(),
        type: "stage.retry",
        targetId: t.id,
        expectedVersion: manual.ticket.version,
        payload: { stage: "implement" },
      }),
    /reserved/,
  );
  s.db.close();
});

import { collectReview } from "../src/server/review.ts";
import { collectPullRequests } from "../src/server/github.ts";
test("review and PR commands cannot dispatch human-only or closed tickets", () => {
  const s = fixture();
  for (const kind of ["human_only", "closed"]) {
    let t = create(s, {
      handling: kind === "human_only" ? "human_only" : "agent_managed",
    });
    if (kind === "closed")
      t = s.command(user, {
        commandId: randomUUID(),
        type: "ticket.complete",
        targetId: t.id,
        expectedVersion: t.version,
        payload: {},
      }).ticket;
    for (const type of ["ticket.review", "ticket.validate", "ticket.refreshPr"])
      assert.throws(
        () =>
          s.command(user, {
            commandId: randomUUID(),
            type,
            targetId: t.id,
            expectedVersion: t.version,
            payload: {},
          }),
        /eligible|cannot run/i,
      );
  }
  s.db.close();
});
test("independent review rejects contradictory results and does not resolve findings against an old revision", () => {
  const s = fixture();
  const t = create(s);
  t.revision = "new";
  s.putTicket(t);
  const conv = {
    id: randomUUID(),
    ticketId: t.id,
    provider: "codex" as const,
    model: "fixture",
    role: "worker",
    stage: "review" as const,
    reviewRevision: "old",
    cwd: s.home,
    incarnation: 1,
    state: "idle",
    inputOwner: "automation",
    version: 1,
  };
  const id = randomUUID();
  s.db
    .prepare("INSERT INTO findings VALUES(?,?,?)")
    .run(
      id,
      t.id,
      JSON.stringify({ severity: "blocking", status: "open", revision: "old" }),
    );
  assert.throws(
    () =>
      collectReview(
        s,
        conv,
        JSON.stringify({
          verdict: "passed",
          summary: "invalid",
          findings: [
            {
              title: "bad",
              description: "bug",
              severity: "blocking",
              location: "x:1",
            },
          ],
          resolvedFindingIds: [],
        }),
      ),
    /both a pass/,
  );
  collectReview(
    s,
    conv,
    JSON.stringify({
      verdict: "passed",
      summary: "old result",
      findings: [],
      resolvedFindingIds: [id],
    }),
  );
  assert.equal(
    JSON.parse(
      (s.db.prepare("SELECT data FROM findings WHERE id=?").get(id) as any)
        .data,
    ).status,
    "open",
  );
  assert.equal(s.ticket(t.id, user).status, "active");
  s.db.close();
});
test("remote head drift prevents completion even when old checks passed", async () => {
  const s = fixture();
  const t = create(s, {
    links: [
      { kind: "github_pr", url: "https://github.com/example/repo/pull/1" },
    ],
  });
  t.revision = "rev";
  t.completionContract = "reviewed_draft";
  s.putTicket(t);
  s.setting("revision:rev", {
    head: "head1",
    base: "base1",
    repository: "https://github.com/example/repo.git",
  });
  for (const requirement of [
    "validation",
    "review",
    "ci:https://github.com/example/repo/pull/1",
  ])
    s.command(
      { kind: "collector", id: "test" },
      {
        commandId: randomUUID(),
        type: "evidence.register",
        targetId: t.id,
        expectedVersion: s.ticket(t.id, user).version,
        payload: {
          revision: "rev",
          requirement,
          verdict: "passed",
          provenance: "fixture",
        },
      },
    );
  assert.equal(s.ticket(t.id, user).status, "awaiting_decision");
  await collectPullRequests(s, t.id, async (route) =>
    route.endsWith("/pulls/1")
      ? {
          head: { sha: "head2" },
          base: { sha: "base1" },
          state: "open",
          merged: false,
        }
      : route.includes("check-runs")
        ? { check_runs: [], total_count: 0 }
        : route.endsWith("/status")
          ? { state: "pending", statuses: [], total_count: 0 }
          : [],
  );
  assert.throws(
    () =>
      s.command(user, {
        commandId: randomUUID(),
        type: "ticket.claimComplete",
        targetId: t.id,
        expectedVersion: s.ticket(t.id, user).version,
        payload: { rationale: "stale" },
      }),
    /lacks required/,
  );
  s.db.close();
});

test("shadow delta refreshes unchanged imported records and surfaces competing local edits", () => {
  const s = fixture();
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "fm-delta-"));
  fs.mkdirSync(path.join(legacy, "data"));
  const backlog = path.join(legacy, "data", "backlog.md");
  fs.writeFileSync(
    backlog,
    "## Queued\n- [ ] stable-task - Original\n  blocked-by: external approval\n",
  );
  importLegacy(s, legacy);
  let t = s.tickets(user)[0];
  assert.ok(t.brief.includes("blocked-by"));
  assert.throws(
    () =>
      s.command(user, {
        commandId: randomUUID(),
        type: "runtime.pause",
        payload: { paused: false },
      }),
    /Shadow/,
  );
  fs.writeFileSync(backlog, "## Queued\n- [ ] stable-task - Updated\n");
  importLegacy(s, legacy);
  t = s.ticket(t.id, user);
  assert.ok(t.title.includes("Updated"));
  assert.equal(s.tickets(user).length, 1);
  s.command(user, {
    commandId: randomUUID(),
    type: "ticket.update",
    targetId: t.id,
    expectedVersion: t.version,
    payload: { title: "Local edit" },
  });
  fs.writeFileSync(backlog, "## Done\n- [x] stable-task - External edit\n");
  const report = importLegacy(s, legacy);
  assert.ok(report.unresolved.some((x) => x.includes("reconciliation")));
  assert.equal(s.ticket(t.id, user).title, "Local edit");
  assert.ok(s.setting("migration-conflict:" + t.id));
  s.db.close();
  fs.rmSync(legacy, { recursive: true, force: true });
});

test("Claude tool interruption expires permission without reporting success or retrying", () => {
  const s = fixture();
  const t = create(s);
  const cid = randomUUID();
  const c = {
    id: cid,
    ticketId: t.id,
    provider: "claude" as const,
    model: "claude-sonnet-4-6",
    role: "worker",
    cwd: s.home,
    incarnation: 1,
    state: "waiting_permission",
    inputOwner: "automation",
    version: 1,
  };
  s.putConversation(c);
  s.putAttempt({
    id: randomUUID(),
    ticketId: t.id,
    conversationId: cid,
    role: "implement",
    state: "running",
    ordinal: 1,
    createdAt: new Date().toISOString(),
  });
  const runtime = new Runtime(s);
  runtime.apply(c, {
    type: "permission.request",
    payload: { id: "permission", incarnation: 1 },
    at: new Date().toISOString(),
  });
  runtime.apply(c, {
    type: "claude.event",
    payload: {
      type: "result",
      uuid: "interrupted-result",
      is_error: true,
      firstmateInterrupted: true,
    },
    at: new Date().toISOString(),
  });
  runtime.apply(c, {
    type: "permission.expired",
    payload: {},
    at: new Date().toISOString(),
  });
  assert.equal(s.conversation(cid, user).state, "idle");
  assert.equal(s.attempts(t.id)[0].state, "interrupted");
  assert.equal(
    (
      s.db
        .prepare("SELECT state FROM permissions WHERE id='permission'")
        .get() as any
    ).state,
    "expired",
  );
  assert.equal(
    (s.db.prepare("SELECT count(*) n FROM retries").get() as any).n,
    0,
  );
  assert.notEqual(s.ticket(t.id, user).status, "completed");
  s.db.close();
});
