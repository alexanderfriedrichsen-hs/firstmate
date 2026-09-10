import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { CursorACP } from "../src/server/cursor-acp.ts";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function fake() {
  const calls: any[] = [],
    events: any[] = [];
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.exitCode = 0;
  };
  child.stdin = new Writable({
    write(data, _encoding, done) {
      calls.push(JSON.parse(String(data)));
      done();
    },
  });
  const acp = new CursorACP(
    "unused",
    "/tmp",
    (type, payload) => events.push({ type, payload }),
    child,
  );
  const response = (id: number, result: any) =>
    child.stdout.write(JSON.stringify({ id, result }) + "\n");
  return { acp, calls, events, response, child };
}
test("Cursor cancel during model setup never launches a new prompt", async () => {
  const f = fake();
  f.acp.sessionId = "exact";
  const turn = f.acp.prompt("hello", "model");
  f.acp.cancel();
  f.response(f.calls[0].id, {});
  assert.equal((await turn).stopReason, "cancelled");
  assert.ok(!f.calls.some((c) => c.method === "session/prompt"));
});
test("Cursor resumes exact identity without replay and grants only offered one-time permission", async () => {
  const f = fake();
  const init = f.acp.initialize("/tmp", "exact");
  f.response(f.calls[0].id, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls[1].method, "authenticate");
  f.response(f.calls[1].id, {});
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls[2].params.sessionId, "exact");
  f.child.stdout.write(
    JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "exact",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "old" },
        },
      },
    }) + "\n",
  );
  f.response(f.calls[2].id, {});
  assert.equal(await init, "exact");
  assert.equal(f.events.length, 0);
  f.child.stdout.write(
    JSON.stringify({
      id: 55,
      method: "session/request_permission",
      params: {
        sessionId: "exact",
        options: [{ kind: "allow_always", optionId: "all" }],
      },
    }) + "\n",
  );
  const id = f.events[0].payload.id;
  assert.throws(() => f.acp.permission(id, "accept"), /one-time/);
  f.acp.permission(id, "decline");
  assert.deepEqual(f.calls.at(-1).result, {
    outcome: { outcome: "cancelled" },
  });
});
test("provider restart preserves old identity and requires explicit Cursor policy", () => {
  const s = new Store(
    homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-providers-"))),
  );
  s.fence();
  const user = { kind: "user" as const, id: "test" };
  const command = (type: string, payload: any = {}, conversation?: any) =>
    s.command(user, {
      commandId: randomUUID(),
      type,
      payload,
      targetId: conversation?.id,
      expectedVersion: conversation?.version,
    });
  const c = command("conversation.create", {
    provider: "claude",
    model: "sonnet",
    role: "supervisor",
  }).conversation;
  c.state = "idle";
  c.providerId = "claude-native";
  s.putConversation(c);
  s.db.prepare("UPDATE outbox SET state='accepted'").run();
  assert.throws(
    () =>
      command("conversation.restart", { provider: "cursor", model: "auto" }, c),
    /subscription usage/,
  );
  command("provider.cursor.subscription");
  s.setting("providerModelCatalog.cursor", [
    { model: "auto", supportedReasoningEfforts: [] },
  ]);
  command("conversation.restart", { provider: "cursor", model: "auto" }, c);
  const list = s.conversations(user);
  const next = list.find((x) => !x.retiredAt)!;
  assert.equal(next.provider, "cursor");
  assert.equal(next.providerId, undefined);
  assert.equal(next.previousConversationId, c.id);
  assert.equal(list.find((x) => x.id === c.id)?.providerId, "claude-native");
  s.db.close();
});
test("Cursor permission IDs are globally unique and cancelled options cannot approve tools", () => {
  const a = fake(),
    b = fake();
  a.acp.sessionId = "a";
  b.acp.sessionId = "b";
  for (const [f, sessionId] of [
    [a, "a"],
    [b, "b"],
  ] as const) {
    f.child.stdout.write(
      JSON.stringify({
        id: 1,
        method: "session/request_permission",
        params: {
          sessionId,
          options: [{ kind: "allow_once", optionId: "once" }],
        },
      }) + "\n",
    );
  }
  assert.notEqual(a.events[0].payload.id, b.events[0].payload.id);
  a.acp.cancel();
  assert.throws(
    () => a.acp.permission(a.events[0].payload.id, "accept"),
    /no longer pending/,
  );
  b.acp.permission(b.events[0].payload.id, "accept");
  assert.equal(b.calls.at(-1).result.outcome.optionId, "once");
});

test("agent CLI shell arguments preserve spaces and shell metacharacters", async () => {
  const { shellArgument } = await import("../src/server/runtime.ts");
  const { execFileSync } = await import("node:child_process");
  const values = [
    "/Library/Application Support/Firstmate/cli.ts",
    "/tmp/a'b/loader.mjs",
    "/tmp/$(touch SHOULD_NOT_EXIST)`echo bad`$HOME",
  ];
  const result = execFileSync(
    "/bin/sh",
    ["-c", "printf '%s\\n' " + values.map(shellArgument).join(" ")],
    { encoding: "utf8" },
  );
  assert.deepEqual(result.trimEnd().split("\n"), values);
});
