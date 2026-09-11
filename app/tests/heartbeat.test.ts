import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { Runtime } from "../src/server/runtime.ts";
import {
  checkHeartbeat,
  heartbeatStatus,
  heartbeatCompleted,
  configureHeartbeat,
} from "../src/server/heartbeat.ts";
function fixture() {
  const home = homePath(
    fs.mkdtempSync(path.join(os.tmpdir(), "fm-heartbeat-")),
  );
  const store = new Store(home);
  store.fence();
  const user = { kind: "user" as const, id: "test" };
  const command = (type: string, payload: any = {}, actor: any = user) =>
    store.command(actor, { commandId: randomUUID(), type, payload });
  return {
    store,
    home,
    command,
    close: () => {
      store.db.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
test("durable heartbeat catches up once and does not expose human-only work", () => {
  const f = fixture();
  const t = Date.now();
  try {
    f.command("ticket.create", {
      title: "Secret private text",
      handling: "human_only",
    });
    checkHeartbeat(f.store, t);
    assert.equal(f.store.setting("heartbeat").pendingWakeId, null);
    assert.match(f.store.setting("heartbeat").summary, /0 active managed/);
    f.command("ticket.create", { title: "Managed", handling: "agent_managed" });
    checkHeartbeat(f.store, t + 600000);
    const id = f.store.setting("heartbeat").pendingWakeId;
    assert.ok(id);
    const data = f.store.db
      .prepare("SELECT data FROM wakes WHERE id=?")
      .get(id) as any;
    assert.ok(!data.data.includes("Secret"));
    checkHeartbeat(f.store, t + 86400000);
    assert.equal(f.store.setting("heartbeat").pendingWakeId, id);
    f.store.db.close();
    const next = new Store(f.home);
    next.fence();
    checkHeartbeat(next, t + 86400001);
    assert.equal(next.setting("heartbeat").pendingWakeId, id);
    assert.equal(
      (
        next.db
          .prepare("SELECT count(*) n FROM wakes WHERE id LIKE 'heartbeat:%'")
          .get() as any
      ).n,
      1,
    );
    next.db.close();
  } finally {
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
test("heartbeat delivery respects pause busy ownership, acknowledgement and disable cancellation", () => {
  const f = fixture();
  const t = Date.now();
  try {
    const c: any = {
      id: randomUUID(),
      provider: "codex",
      model: "test",
      role: "supervisor",
      cwd: f.home,
      incarnation: 0,
      state: "idle",
      inputOwner: "automation",
      version: 1,
    };
    f.store.putConversation(c);
    f.command("ticket.create", { title: "Managed", handling: "agent_managed" });
    f.store.db.prepare("UPDATE wakes SET state='handled'").run();
    checkHeartbeat(f.store, t);
    const id = f.store.setting("heartbeat").pendingWakeId;
    const runtime = new Runtime(f.store);
    f.store.setting("policy", { ...f.store.setting("policy"), paused: true });
    runtime.scheduleWakes();
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
      0,
    );
    f.store.setting("policy", { ...f.store.setting("policy"), paused: false });
    for (const state of ["running", "waiting_permission"]) {
      c.state = state;
      f.store.putConversation(c);
      runtime.scheduleWakes();
    }
    c.state = "idle";
    c.inputOwner = "test";
    f.store.putConversation(c);
    runtime.scheduleWakes();
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
      0,
    );
    c.inputOwner = "automation";
    f.store.putConversation(c);
    runtime.scheduleWakes();
    runtime.scheduleWakes();
    assert.equal(
      (
        f.store.db
          .prepare("SELECT count(*) n FROM outbox WHERE state='pending'")
          .get() as any
      ).n,
      1,
    );
    f.command("wake.ack", { id }, { kind: "supervisor", id: c.id });
    assert.ok(f.store.setting("heartbeat").lastAckAt);
    assert.throws(
      () => f.command("wake.ack", { id }, { kind: "supervisor", id: c.id }),
      /no longer pending/,
    );
    f.store.db.prepare("UPDATE outbox SET state='accepted'").run();
    checkHeartbeat(f.store, t + 600000);
    runtime.scheduleWakes();
    const next = f.store.setting("heartbeat").pendingWakeId;
    f.store.db
      .prepare("INSERT INTO wakes VALUES(?,?,?,?,?)")
      .run("unrelated", null, "pending", "{}", new Date(t).toISOString());
    configureHeartbeat(f.store, false, 10, t + 600001);
    assert.equal(
      (
        f.store.db
          .prepare("SELECT state FROM wakes WHERE id='unrelated'")
          .get() as any
      ).state,
      "pending",
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT state FROM wakes WHERE id=?")
          .get(next) as any
      ).state,
      "cancelled",
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT count(*) n FROM outbox WHERE state='pending'")
          .get() as any
      ).n,
      0,
    );
  } finally {
    f.close();
  }
});
test("health reports stale completed loops overdue scans and exhausted retries", () => {
  const f = fixture();
  const t = Date.now();
  try {
    checkHeartbeat(f.store, t);
    heartbeatCompleted(f.store, t);
    assert.notEqual(heartbeatStatus(f.store, t).status, "stale");
    assert.equal(heartbeatStatus(f.store, t + 60001).status, "stale");
    heartbeatCompleted(f.store, t + 800000);
    assert.ok(
      heartbeatStatus(f.store, t + 800000).issues.some(
        (i: { code: string }) => i.code === "heartbeat_overdue",
      ),
    );
    assert.throws(() =>
      f.command("heartbeat.configure", { enabled: true, intervalMinutes: 0 }),
    );
    assert.throws(() =>
      f.command(
        "heartbeat.configure",
        { enabled: true, intervalMinutes: 10 },
        { kind: "supervisor", id: "no" },
      ),
    );
    f.command("ticket.create", { title: "Work" });
    checkHeartbeat(f.store, t + 800001);
    const id = f.store.setting("heartbeat").pendingWakeId;
    const row = f.store.db
      .prepare("SELECT data FROM wakes WHERE id=?")
      .get(id) as any;
    f.store.db
      .prepare("UPDATE wakes SET state='presented',data=? WHERE id=?")
      .run(
        JSON.stringify({
          ...JSON.parse(row.data),
          presentations: 3,
          nextAt: new Date(t + 1400000).toISOString(),
        }),
        id,
      );
    assert.ok(
      !heartbeatStatus(f.store, t + 800001).issues.some(
        (i: any) => i.code === "heartbeat_exhausted",
      ),
    );
    assert.ok(
      heartbeatStatus(f.store, t + 1400000).issues.some(
        (i: { code: string }) => i.code === "heartbeat_exhausted",
      ),
    );
    checkHeartbeat(f.store, t + 9000000);
    assert.notEqual(f.store.setting("heartbeat").pendingWakeId, id);
    assert.equal(
      (f.store.db.prepare("SELECT state FROM wakes WHERE id=?").get(id) as any)
        .state,
      "exhausted",
    );
    configureHeartbeat(f.store, false, 10, t + 9000000);
    configureHeartbeat(f.store, true, 10, t + 9000000);
    checkHeartbeat(f.store, t + 9600000);
    assert.notEqual(f.store.setting("heartbeat").pendingWakeId, id);
  } finally {
    f.close();
  }
});

test("arm health identifies invalid runners and keeps retained workers observation-only", () => {
  const f = fixture();
  const t = Date.now();
  try {
    const external = f.command("ticket.create", { title: "External" }).ticket;
    f.store.setting("legacy:" + external.id, { management: "external" });
    f.store.setting("legacyExternalChanges", { requiresReconciliation: true });
    const managed = f.command("ticket.create", { title: "Managed" }).ticket;
    const c: any = {
      id: randomUUID(),
      ticketId: managed.id,
      provider: "codex",
      model: "test",
      role: "worker",
      cwd: path.join(f.home, "missing"),
      incarnation: 1,
      runnerId: randomUUID(),
      state: "running",
      inputOwner: "automation",
      version: 1,
    };
    f.store.putConversation(c);
    checkHeartbeat(f.store, t);
    const state = f.store.setting("heartbeat");
    assert.match(
      state.summary,
      /1 active managed tickets; 1 retained external/,
    );
    assert.ok(state.issues.some((i: any) => i.code === "runner_unverified"));
    assert.ok(state.issues.some((i: any) => i.code === "lease_unavailable"));
    assert.ok(state.issues.some((i: any) => i.code === "external_observation"));
    assert.equal(
      f.store.setting("legacy:" + external.id).management,
      "external",
    );
    f.store.setting("generation", f.store.generation + 1);
    assert.throws(() => checkHeartbeat(f.store, t + 600000));
  } finally {
    f.close();
  }
});

test("idle health issues notify again after recovery or explicit retry, without duplicate wakes", () => {
  const f = fixture();
  const t = Date.now();
  try {
    const c: any = {
      id: randomUUID(),
      provider: "codex",
      model: "test",
      role: "supervisor",
      cwd: f.home,
      incarnation: 1,
      runnerId: randomUUID(),
      state: "idle",
      inputOwner: "automation",
      version: 1,
    };
    f.store.putConversation(c);
    checkHeartbeat(f.store, t);
    const first = f.store.setting("heartbeat").pendingWakeId;
    assert.ok(first);
    f.store.db
      .prepare("UPDATE wakes SET state='presented' WHERE id=?")
      .run(first);
    f.command("wake.ack", { id: first }, { kind: "supervisor", id: c.id });
    const runner = c.runnerId;
    delete c.runnerId;
    f.store.putConversation(c);
    checkHeartbeat(f.store, t + 600000);
    assert.equal(f.store.setting("heartbeat").pendingWakeId, null);
    c.runnerId = runner;
    f.store.putConversation(c);
    checkHeartbeat(f.store, t + 1200000);
    const recurring = f.store.setting("heartbeat").pendingWakeId;
    assert.ok(recurring, "same issue after recovery must notify again");
    assert.notEqual(recurring, first);
    checkHeartbeat(f.store, t + 1800000);
    assert.equal(f.store.setting("heartbeat").pendingWakeId, recurring);
    configureHeartbeat(f.store, false, 10, t + 1800001);
    configureHeartbeat(f.store, true, 10, t + 1800002);
    checkHeartbeat(f.store, t + 2400002);
    const retried = f.store.setting("heartbeat").pendingWakeId;
    assert.ok(
      retried,
      "explicit retry must re-notify unchanged issue-only fleet",
    );
    assert.notEqual(retried, recurring);
    checkHeartbeat(f.store, t + 3000002);
    assert.equal(f.store.setting("heartbeat").pendingWakeId, retried);
  } finally {
    f.close();
  }
});
