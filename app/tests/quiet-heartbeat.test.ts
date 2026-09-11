import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { Runtime } from "../src/server/runtime.ts";

test("scheduled heartbeat stays intact for the model and audit but is compact in chat, including legacy history", (t) => {
  const home = homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-quiet-")));
  const store = new Store(home);
  store.fence();
  t.after(() => {
    store.db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const cid = randomUUID();
  store.putConversation({
    id: cid,
    provider: "codex",
    model: "test",
    role: "supervisor",
    cwd: home,
    incarnation: 0,
    state: "idle",
    inputOwner: "automation",
    version: 1,
  });
  store.setting("heartbeat", { enabled: true });
  store.setting("policy", { ...store.setting("policy"), paused: false });
  store.db
    .prepare("INSERT INTO wakes VALUES(?,?,?,?,?)")
    .run(
      "heartbeat:test",
      null,
      "pending",
      JSON.stringify({ kind: "heartbeat", summary: "review fleet" }),
      new Date().toISOString(),
    );
  new Runtime(store).scheduleWakes();
  const message = store.messages(cid)[0];
  assert.equal(message.kind, "scheduled_heartbeat");
  assert.match(message.content, /^Scheduled fleet heartbeat\./);
  const effect = store.db
    .prepare("SELECT payload FROM outbox WHERE target_id=?")
    .get(cid) as any;
  assert.equal(JSON.parse(effect.payload).text, message.content);
  // Simulate an existing pre-upgrade message without changing its audit content.
  store.db
    .prepare("UPDATE messages SET kind='message' WHERE id=?")
    .run(message.id);
  assert.equal(store.messages(cid)[0].kind, "scheduled_heartbeat");
  const manual = randomUUID();
  store.message(cid, manual, "user", message.content, "message");
  assert.equal(
    store.messages(cid).find((m) => m.id === manual)!.kind,
    "message",
  );
  const conversation = store.conversation(cid, { kind: "user", id: "test" });
  store.command(
    { kind: "user", id: "test" },
    {
      commandId: randomUUID(),
      type: "conversation.send",
      targetId: cid,
      expectedVersion: conversation.version,
      payload: { text: message.content, wakeId: "heartbeat:test" },
    },
  );
  assert.equal(
    store.messages(cid).at(-1)!.kind,
    "message",
    "user cannot spoof scheduler provenance",
  );
});
