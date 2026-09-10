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
function fake(fullAccess = false) {
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
    fullAccess,
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

test("Cursor full access approves offered tool permissions but waits for real questions", () => {
  const f = fake(true);
  f.acp.sessionId = "exact";
  f.child.stdout.write(
    JSON.stringify({
      id: 100,
      method: "session/request_permission",
      params: {
        sessionId: "exact",
        options: [{ kind: "allow_always", optionId: "persistent" }],
      },
    }) + "\n",
  );
  assert.equal(f.calls.at(-1).result.outcome.optionId, "persistent");
  assert.ok(!f.events.some((e) => e.type === "permission.request"));
  const question = {
    id: 101,
    method: "cursor/ask_question",
    params: {
      questions: [
        {
          id: "flavor",
          prompt: "Pick one",
          options: [
            { id: "native-a", label: "A" },
            { id: "native-b", label: "B" },
          ],
        },
      ],
    },
  };
  f.child.stdout.write(JSON.stringify(question) + "\n");
  const pending = f.events.find((e) => e.payload.kind === "question").payload;
  assert.ok(!f.calls.some((c) => c.id === 101));
  assert.throws(
    () => f.acp.answer(pending.id, { flavor: { answers: ["unknown"] } }),
    /offered/,
  );
  f.acp.answer(pending.id, { flavor: { answers: ["B"] } });
  assert.deepEqual(f.calls.at(-1).result, {
    outcome: {
      outcome: "answered",
      answers: [{ questionId: "flavor", selectedOptionIds: ["native-b"] }],
    },
  });
  assert.throws(
    () => f.acp.answer(pending.id, { flavor: { answers: ["B"] } }),
    /no longer pending/,
  );
  f.child.stdout.write(JSON.stringify({ ...question, id: 102 }) + "\n");
  const next = f.events
    .filter((e) => e.payload.kind === "question")
    .at(-1).payload;
  f.acp.cancel();
  assert.ok(
    f.calls.some(
      (c) => c.id === 102 && c.result.outcome.outcome === "cancelled",
    ),
  );
  assert.throws(
    () => f.acp.answer(next.id, { flavor: { answers: ["A"] } }),
    /no longer pending/,
  );
});

test("Cursor new and resumed full-access sessions select only an advertised agent mode", async () => {
  for (const resume of [undefined, "exact"]) {
    for (const advertised of [true, false]) {
      const f = fake(true);
      const initialized = f.acp.initialize("/tmp", resume);
      f.response(f.calls[0].id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      });
      await new Promise((r) => setImmediate(r));
      f.response(f.calls[1].id, {});
      await new Promise((r) => setImmediate(r));
      assert.equal(f.calls[2].method, resume ? "session/load" : "session/new");
      f.child.stdout.write(
        JSON.stringify({
          method: "session/update",
          params: {
            sessionId: "exact",
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "review", description: "Review" }],
            },
          },
        }) + "\n",
      );
      f.response(f.calls[2].id, {
        sessionId: "exact",
        modes: {
          currentModeId: "plan",
          availableModes: advertised ? [{ id: "agent" }] : [{ id: "plan" }],
        },
      });
      await new Promise((r) => setImmediate(r));
      if (advertised) {
        assert.deepEqual(f.calls[3].params, {
          sessionId: "exact",
          modeId: "agent",
        });
        assert.equal(f.calls[3].method, "session/set_mode");
        f.response(f.calls[3].id, {});
      } else assert.equal(f.calls.length, 3);
      assert.equal(await initialized, "exact");
      assert.equal(
        f.events.find((e) => e.type === "cursor.update").payload
          .availableCommands[0].name,
        "review",
      );
    }
  }
});
