import { Runtime } from "../src/server/runtime.ts";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { reconcileLaunch } from "../src/server/launch-recovery.ts";
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
test("timed-out initial allocation reconciles the same launch and preserves its queued message", () => {
  const f = fixture();
  try {
    const before = f.s.db
      .prepare("SELECT id FROM outbox WHERE kind='conversation.launch'")
      .get();
    reconcileLaunch(f.s, f.c, () => []);
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
test("uncertain native identity, active allocator, duplicate holders, and missing recorded lease never requeue", () => {
  for (const variant of ["native", "allocator", "duplicate", "missing"]) {
    const f = fixture();
    try {
      if (variant === "native") f.c.providerId = "native-id";
      if (variant === "missing")
        f.s.setting("lease:" + f.c.id, { lease_id: "recorded" });
      assert.throws(
        () =>
          reconcileLaunch(f.s, f.c, () => {
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

test("reconciliation retains an exact lease and refuses active or reassigned identities", () => {
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
    reconcileLaunch(f.s, f.c, () => [lease]);
    assert.equal(f.s.setting("lease:" + f.c.id).lease_id, "exact");
    f.s.db
      .prepare(
        "UPDATE outbox SET state='uncertain' WHERE kind='conversation.launch'",
      )
      .run();
    assert.throws(
      () => reconcileLaunch(f.s, f.c, () => [{ ...lease, lease_id: "other" }]),
      /ambiguous/,
    );
    assert.throws(
      () =>
        reconcileLaunch(f.s, f.c, () => [
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
