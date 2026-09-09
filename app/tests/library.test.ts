import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { collectOutputs, recordNativeReads } from "../src/server/library.ts";
const user = { kind: "user" as const, id: "test" };
function fixture() {
  const home = homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-library-")));
  const s = new Store(home);
  s.fence();
  const c = {
    id: randomUUID(),
    provider: "codex" as const,
    model: "old",
    role: "supervisor" as const,
    cwd: home,
    incarnation: 0,
    state: "idle" as const,
    inputOwner: "automation",
    version: 1,
  };
  s.putConversation(c);
  return {
    s,
    c,
    close() {
      s.db.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
test("model changes preserve native history and new chat retires the old chat exactly once", () => {
  const { s, c, close } = fixture();
  try {
    s.message(c.id, "old-message", "assistant", "Keep this history", "message");
    s.command(user, {
      commandId: randomUUID(),
      type: "conversation.model",
      targetId: c.id,
      expectedVersion: 1,
      payload: { model: "new" },
    });
    assert.equal(s.conversation(c.id, user).model, "new");
    const cmd = {
      commandId: randomUUID(),
      type: "conversation.restart",
      targetId: c.id,
      expectedVersion: 2,
      payload: {},
    };
    const result = s.command(user, cmd);
    assert.deepEqual(s.command(user, cmd), JSON.parse(JSON.stringify(result)));
    const all = s.conversations(user);
    assert.equal(all.length, 2);
    const next = all.find((x) => !x.retiredAt)!;
    assert.equal(next.previousConversationId, c.id);
    assert.equal(next.model, "new");
    assert.equal(next.cwd, c.cwd);
    assert.equal(next.inputOwner, "test");
    assert.equal(next.providerId, undefined);
    assert.equal(
      (
        s.db
          .prepare("SELECT content FROM messages WHERE conversation_id=?")
          .get(c.id) as any
      ).content,
      "Keep this history",
    );
    assert.throws(
      () =>
        s.command(user, {
          commandId: randomUUID(),
          type: "conversation.send",
          targetId: c.id,
          expectedVersion: 3,
          payload: { text: "No" },
        }),
      /retained history/,
    );
  } finally {
    close();
  }
});
test("chat changes reject pending sends and unverified skill paths", () => {
  const { s, c, close } = fixture();
  try {
    assert.throws(
      () =>
        s.command(user, {
          commandId: randomUUID(),
          type: "conversation.send",
          targetId: c.id,
          expectedVersion: 1,
          payload: {
            text: "No",
            skills: [{ name: "unknown", path: "/tmp/private.md" }],
          },
        }),
      /skill/i,
    );
    assert.equal(
      (s.db.prepare("SELECT COUNT(*) n FROM messages").get() as any).n,
      0,
    );
    s.command(user, {
      commandId: randomUUID(),
      type: "conversation.send",
      targetId: c.id,
      expectedVersion: 1,
      payload: { text: "Queued" },
    });
    assert.throws(
      () =>
        s.command(user, {
          commandId: randomUUID(),
          type: "conversation.restart",
          targetId: c.id,
          expectedVersion: 2,
          payload: {},
        }),
      /pending input/,
    );
  } finally {
    close();
  }
});
test("artifact capture imports workspace deliverables once, excludes symlinks, and records evidenced reads", () => {
  const { s, c, close } = fixture();
  try {
    fs.mkdirSync(path.join(c.cwd, "outputs"));
    fs.writeFileSync(path.join(c.cwd, "outputs", "report.md"), "# Report");
    fs.writeFileSync(path.join(c.cwd, "linked.md"), "Linked report");
    fs.symlinkSync(
      path.join(c.cwd, "linked.md"),
      path.join(c.cwd, "outputs", "symlink.md"),
    );
    s.message(
      c.id,
      "links",
      "assistant",
      "[Report](linked.md) [External](/etc/hosts)",
      "message",
    );
    collectOutputs(s, c);
    collectOutputs(s, c);
    assert.equal(
      (s.db.prepare("SELECT COUNT(*) n FROM artifacts").get() as any).n,
      2,
    );
    assert.equal(
      (
        s.db
          .prepare("SELECT COUNT(*) n FROM messages WHERE kind='activity'")
          .get() as any
      ).n,
      2,
    );
    recordNativeReads(s, c, {
      type: "commandExecution",
      exitCode: 1,
      aggregatedOutput: "failed",
      commandActions: [{ type: "read", path: "AGENTS.md" }],
    });
    assert.equal(s.setting("context:" + c.id), null);
    recordNativeReads(s, c, {
      type: "commandExecution",
      exitCode: 0,
      aggregatedOutput: "actual captured output",
      commandActions: [{ type: "read", path: "AGENTS.md" }],
    });
    assert.equal(s.setting("context:" + c.id).length, 1);
    assert.match(s.setting("context:" + c.id)[0].source, /may be partial/);
  } finally {
    close();
  }
});

test("older runners cannot silently ignore model and skill controls", () => {
  const { s, c, close } = fixture();
  try {
    const runnerId = randomUUID();
    s.putConversation({ ...c, runnerId });
    assert.throws(
      () =>
        s.command(user, {
          commandId: randomUUID(),
          type: "conversation.model",
          targetId: c.id,
          expectedVersion: 1,
          payload: { model: "new" },
        }),
      /Park and resume/,
    );
    assert.equal(s.conversation(c.id, user).model, "old");
  } finally {
    close();
  }
});
