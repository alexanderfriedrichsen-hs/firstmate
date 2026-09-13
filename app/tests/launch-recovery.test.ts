import { Runtime } from "../src/server/runtime.ts";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { checkHeartbeat, heartbeatStatus } from "../src/server/heartbeat.ts";
import {
  reconcileLaunch,
  mapWithConcurrency,
} from "../src/server/launch-recovery.ts";
function fixture() {
  const s = new Store(
    homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-launch-recovery-"))),
  );
  s.fence();
  s.setting("project", { source: s.home, remote: "test" });
  s.setting("providerModelCatalog.codex", [{ model: "test" }]);
  const actor = { kind: "user" as const, id: "test" };
  const command = (type: string, payload: any = {}, target?: any) =>
    s.command(actor, {
      commandId: randomUUID(),
      type,
      payload,
      targetId: target?.id,
      expectedVersion: target?.version,
    });
  const t = command("ticket.create", { title: "Cold allocation" }).ticket;
  const c = command("conversation.create", {
    ticketId: t.id,
    provider: "codex",
    model: "test",
    role: "worker",
  }).conversation;
  s.db
    .prepare(
      "UPDATE outbox SET state='uncertain' WHERE kind='conversation.launch'",
    )
    .run();
  command("conversation.send", { text: "Keep this queued evidence" }, c);
  return {
    s,
    c,
    command,
    close() {
      s.db.close();
      fs.rmSync(s.home, { recursive: true, force: true });
    },
  };
}
test("timed-out initial allocation reconciles the same launch and preserves its queued message", async () => {
  const f = fixture();
  try {
    const before = f.s.db
      .prepare("SELECT id FROM outbox WHERE kind='conversation.launch'")
      .get();
    await reconcileLaunch(f.s, f.c, async () => []);
    assert.deepEqual(
      f.s.db
        .prepare("SELECT id FROM outbox WHERE kind='conversation.launch'")
        .get(),
      before,
    );
    assert.equal(
      (
        f.s.db
          .prepare("SELECT state FROM outbox WHERE kind='conversation.launch'")
          .get() as any
      ).state,
      "pending",
    );
    assert.equal(
      (
        f.s.db
          .prepare(
            "SELECT count(*) n FROM outbox WHERE kind='conversation.send' AND state='pending'",
          )
          .get() as any
      ).n,
      1,
    );
    assert.equal(f.s.conversations({ kind: "user", id: "test" }).length, 1);
  } finally {
    f.close();
  }
});
test("uncertain native identity, active allocator, duplicate holders, and missing recorded lease never requeue", async () => {
  for (const variant of ["native", "allocator", "duplicate", "missing"]) {
    const f = fixture();
    try {
      if (variant === "native") f.c.providerId = "native-id";
      if (variant === "missing")
        f.s.setting("lease:" + f.c.id, { lease_id: "recorded" });
      await assert.rejects(
        () =>
          reconcileLaunch(f.s, f.c, async () => {
            if (variant === "allocator") throw Error("Allocator runs");
            return variant === "duplicate"
              ? [1, 2].map(() => ({
                  lease_holder: "firstmate-attempt-" + f.c.id,
                }))
              : [];
          }),
        /identity|Allocator|Multiple|absent/,
      );
      assert.equal(
        (
          f.s.db
            .prepare(
              "SELECT state FROM outbox WHERE kind='conversation.launch'",
            )
            .get() as any
        ).state,
        "uncertain",
      );
    } finally {
      f.close();
    }
  }
});
test("Firstmate can request reconciliation but cannot duplicate a pending request", () => {
  const f = fixture();
  try {
    const c = f.s.conversation(f.c.id, { kind: "user", id: "test" });
    f.s.command(
      { kind: "supervisor", id: "firstmate" },
      {
        commandId: randomUUID(),
        type: "conversation.reconcileLaunch",
        targetId: c.id,
        expectedVersion: c.version,
        payload: {},
      },
    );
    assert.throws(
      () =>
        f.command(
          "conversation.reconcileLaunch",
          {},
          f.s.conversation(c.id, { kind: "user", id: "test" }),
        ),
      /already queued/,
    );
  } finally {
    f.close();
  }
});

test("reconciliation retains an exact lease and refuses active or reassigned identities", async () => {
  const f = fixture();
  try {
    const cwd = path.join(f.s.home, "allocated");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["remote", "add", "origin", "test"], { cwd });
    const lease = {
      path: cwd,
      status: "leased",
      lease_id: "exact",
      lease_holder: "firstmate-attempt-" + f.c.id,
      processes: [],
    };
    await reconcileLaunch(f.s, f.c, async () => [lease]);
    assert.equal(f.s.setting("lease:" + f.c.id).lease_id, "exact");
    f.s.db
      .prepare(
        "UPDATE outbox SET state='uncertain' WHERE kind='conversation.launch'",
      )
      .run();
    await assert.rejects(
      () =>
        reconcileLaunch(f.s, f.c, async () => [
          { ...lease, lease_id: "other" },
        ]),
      /ambiguous/,
    );
    await assert.rejects(
      () =>
        reconcileLaunch(f.s, f.c, async () => [
          { ...lease, processes: [{ pid: 123 }] },
        ]),
      /ambiguous/,
    );
  } finally {
    f.close();
  }
});

test("automatic initial launch reconciliation is bounded and retains one worker", () => {
  const f = fixture();
  try {
    f.s.setting("policy", { ...f.s.setting("policy"), paused: false });
    const r = new Runtime(f.s);
    for (let i = 0; i < 4; i++) {
      const retry = f.s.setting("launch-recovery:" + f.c.id);
      if (retry)
        f.s.setting("launch-recovery:" + f.c.id, { ...retry, nextAt: 0 });
      r.reconcile(f.s.conversation(f.c.id, { kind: "user", id: "test" }));
      f.s.db
        .prepare(
          "UPDATE outbox SET state='uncertain' WHERE kind='conversation.reconcileLaunch'",
        )
        .run();
    }
    assert.equal(
      (
        f.s.db
          .prepare(
            "SELECT count(*) n FROM outbox WHERE kind='conversation.reconcileLaunch'",
          )
          .get() as any
      ).n,
      3,
    );
    assert.equal(f.s.conversations({ kind: "user", id: "test" }).length, 1);
  } finally {
    f.close();
  }
});

test("a launch stuck dispatching under a stale generation is treated as failed for automatic recovery and heartbeat health", () => {
  const f = fixture();
  try {
    f.s.setting("policy", { ...f.s.setting("policy"), paused: false });
    f.s.db
      .prepare(
        "UPDATE outbox SET state='dispatching',generation=? WHERE kind='conversation.launch'",
      )
      .run(f.s.generation);
    f.s.fence();
    assert.ok(f.s.hasFailedInitialLaunch(f.c.id));
    checkHeartbeat(f.s, Date.now());
    assert.ok(
      heartbeatStatus(f.s).issues.some(
        (i: { code: string }) => i.code === "initial_launch_failed",
      ),
    );
    const r = new Runtime(f.s);
    r.reconcile(f.s.conversation(f.c.id, { kind: "user", id: "test" }));
    assert.equal(
      (
        f.s.db
          .prepare(
            "SELECT count(*) n FROM outbox WHERE kind='conversation.reconcileLaunch'",
          )
          .get() as any
      ).n,
      1,
    );
  } finally {
    f.close();
  }
});

test("reconciliation aborts without requeuing if runtime ownership changes during the asynchronous lease inspection", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        reconcileLaunch(f.s, f.c, async () => {
          f.s.setting("generation", f.s.generation + 1);
          return [];
        }),
      /generation/,
    );
    assert.equal(
      (
        f.s.db
          .prepare("SELECT state FROM outbox WHERE kind='conversation.launch'")
          .get() as any
      ).state,
      "uncertain",
    );
  } finally {
    f.close();
  }
});

test("reconciliation aborts without requeuing if the ticket's lifecycle changes during the asynchronous lease inspection", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () =>
        reconcileLaunch(f.s, f.c, async () => {
          f.command(
            "ticket.cancel",
            {},
            f.s.ticket(f.c.ticketId!, { kind: "user", id: "test" }),
          );
          return [];
        }),
      /lifecycle/,
    );
    assert.equal(
      (
        f.s.db
          .prepare("SELECT state FROM outbox WHERE kind='conversation.launch'")
          .get() as any
      ).state,
      "uncertain",
    );
  } finally {
    f.close();
  }
});

test("mapWithConcurrency bounds concurrent process inspections without blocking the event loop", async () => {
  const items = [1, 2, 3, 4, 5, 6];
  const limit = 3;
  let active = 0;
  let maxActive = 0;
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 10);
  const start = Date.now();
  await mapWithConcurrency(items, limit, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(30);
    active--;
  });
  clearTimeout(timer);
  assert.ok(
    maxActive > 1 && maxActive <= limit,
    `bad concurrency: ${maxActive}`,
  );
  assert.ok(
    Date.now() - start < items.length * 30,
    "ran serially, not concurrently",
  );
  assert.ok(
    timerFired,
    "an unrelated timer never fired; the event loop was blocked",
  );
});

test("mapWithConcurrency propagates the first failure without waiting for every lane to finish", async () => {
  await assert.rejects(
    () =>
      mapWithConcurrency([1, 2, 3, 4], 2, async (i) => {
        if (i === 1) throw new Error("boom");
        await delay(20);
      }),
    /boom/,
  );
});
