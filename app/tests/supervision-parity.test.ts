import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { Runtime, verifiedDead } from "../src/server/runtime.ts";
import {
  checkHeartbeat,
  acknowledgeHeartbeat,
  heartbeatStatus,
} from "../src/server/heartbeat.ts";
function fixture(t: any) {
  const home = homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-parity-")));
  const store = new Store(home);
  store.fence();
  t.after(() => {
    store.db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const runtime = new Runtime(store);
  const user = { kind: "user" as const, id: "test" };
  const create = (title: string) => {
    store.command(user, {
      commandId: randomUUID(),
      type: "ticket.create",
      payload: { title },
    });
    return store.tickets(user).find((t) => t.title === title)!;
  };
  return { home, store, runtime, create };
}
test("retained-only fleet gets ten-minute reviews and intermediate five-minute checks", (t) => {
  const f = fixture(t);
  const ticket = f.create("External");
  f.store.setting("legacy:" + ticket.id, { management: "external" });
  const start = Date.now();
  checkHeartbeat(f.store, start);
  const id = f.store.setting("heartbeat").pendingWakeId;
  assert.ok(id);
  acknowledgeHeartbeat(f.store, id, start);
  f.store.db.prepare("UPDATE wakes SET state='handled' WHERE id=?").run(id);
  checkHeartbeat(f.store, start + 300000);
  assert.equal(f.store.setting("heartbeat").pendingWakeId, null);
  assert.equal(
    f.store.setting("heartbeat").lastCheckAt,
    new Date(start + 300000).toISOString(),
  );
  checkHeartbeat(f.store, start + 600000);
  assert.ok(f.store.setting("heartbeat").pendingWakeId);
  assert.notEqual(f.store.setting("heartbeat").pendingWakeId, id);
});
test("each distinct worker turn and question gets an idempotent supervisor wake", (t) => {
  const f = fixture(t);
  const ticket = f.create("Native");
  const c: any = {
    id: randomUUID(),
    ticketId: ticket.id,
    provider: "codex",
    model: "test",
    role: "worker",
    cwd: f.home,
    incarnation: 1,
    state: "idle",
    inputOwner: "automation",
    version: 1,
  };
  f.store.putConversation(c);
  f.runtime.settle(c, "succeeded", undefined, "turn-1");
  f.runtime.settle(c, "succeeded", undefined, "turn-1");
  f.runtime.settle(c, "succeeded", undefined, "turn-2");
  f.runtime.workerWake(c, "worker.question", "question-1");
  f.runtime.workerWake(c, "worker.question", "question-1");
  const wakes = f.store.db
    .prepare("SELECT data FROM wakes WHERE ticket_id=?")
    .all(ticket.id) as any[];
  assert.equal(
    wakes.filter((w) => JSON.parse(w.data).kind === "attempt.settled").length,
    2,
  );
  assert.equal(
    wakes.filter((w) => JSON.parse(w.data).kind === "worker.question").length,
    1,
  );
  ticket.handling = "human_only";
  f.store.putTicket(ticket);
  f.runtime.workerWake(c, "worker.question", "question-2");
  assert.equal(
    (
      f.store.db
        .prepare(
          "SELECT count(*) n FROM wakes WHERE id LIKE 'worker.question:%'",
        )
        .get() as any
    ).n,
    1,
  );
});
test("recovery requires dead processes and no uncertain effects; successful turns reset the bounded budget", (t) => {
  const f = fixture(t);
  const c: any = {
    id: randomUUID(),
    provider: "codex",
    providerId: "exact-native",
    model: "test",
    role: "supervisor",
    cwd: f.home,
    runnerId: randomUUID(),
    incarnation: 1,
    state: "lost",
    inputOwner: "automation",
    version: 1,
  };
  f.store.putConversation(c);
  const dir = path.join(f.home, "app", "runners", c.runnerId);
  fs.mkdirSync(dir, { recursive: true });
  const identity = {
    incarnation: 1,
    pid: 99998,
    startIdentity: "prior",
    providerPid: 99997,
    providerStartIdentity: "prior",
  };
  assert.ok(verifiedDead(identity.pid));
  fs.writeFileSync(
    path.join(dir, "identity.json"),
    JSON.stringify({ ...identity, pid: process.pid }),
  );
  f.runtime.scheduleRecovery();
  assert.equal(
    (f.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
    0,
  );
  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify(identity));
  f.store.setting("supervisor-recovery:" + c.id, { attempts: 3, nextAt: 0 });
  f.runtime.scheduleRecovery();
  assert.equal(
    (f.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
    0,
  );
  f.runtime.settle(c, "succeeded", undefined, "verified-turn");
  f.store.setting("policy", { ...f.store.setting("policy"), paused: true });
  f.runtime.scheduleRecovery();
  assert.equal(
    (f.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
    0,
  );
  f.store.setting("policy", { ...f.store.setting("policy"), paused: false });
  f.runtime.scheduleRecovery();
  f.runtime.scheduleRecovery();
  const jobs = f.store.db.prepare("SELECT * FROM outbox").all() as any[];
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "conversation.resume");
  assert.equal(f.store.setting("supervisor-recovery:" + c.id).attempts, 1);
  f.store.db.prepare("UPDATE outbox SET state='uncertain'").run();
  f.store.setting("supervisor-recovery:" + c.id, { attempts: 1, nextAt: 0 });
  f.runtime.scheduleRecovery();
  assert.equal(
    (f.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
    1,
  );
});

test("missed acknowledgement does not disarm future reviews and a later acknowledgement clears active warning", (t) => {
  const f = fixture(t);
  f.create("Work");
  const start = Date.now();
  checkHeartbeat(f.store, start);
  const old = f.store.setting("heartbeat").pendingWakeId;
  f.store.db
    .prepare("UPDATE wakes SET state='presented',data=? WHERE id=?")
    .run(
      JSON.stringify({
        kind: "heartbeat",
        presentations: 3,
        nextAt: new Date(start + 600000).toISOString(),
      }),
      old,
    );
  checkHeartbeat(f.store, start + 600000);
  const next = f.store.setting("heartbeat").pendingWakeId;
  assert.ok(next);
  assert.notEqual(next, old);
  assert.equal(
    (f.store.db.prepare("SELECT state FROM wakes WHERE id=?").get(old) as any)
      .state,
    "exhausted",
  );
  acknowledgeHeartbeat(f.store, next, start + 600001);
  assert.ok(
    !heartbeatStatus(f.store, start + 600001).issues.some(
      (i: any) => i.code === "heartbeat_exhausted",
    ),
  );
});
