import test from "node:test";
import assert from "node:assert/strict";
import {
  mcpApproval,
  mcpQuestions,
  mcpAnswer,
} from "../src/server/elicitation.ts";
const approval = {
  mode: "form",
  serverName: "codex_apps",
  _meta: {
    codex_approval_kind: "tool_suggestion",
    tool_type: "plugin",
    suggest_type: "install",
    tool_id: "linear@openai-curated-remote",
  },
  message: "Authenticate Linear",
  requestedSchema: { type: "object", properties: {} },
};
test("only recognized empty native authorization requests autoaccept", () => {
  assert.deepEqual(mcpApproval(approval), {
    action: "accept",
    content: {},
    _meta: null,
  });
  for (const changed of [
    { _meta: {} },
    { serverName: "other" },
    {
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
    },
    { mode: "url" },
  ])
    assert.equal(mcpApproval({ ...approval, ...changed }), undefined);
  const plain = { ...approval, _meta: {} };
  const form = mcpQuestions(plain);
  assert.throws(() => mcpAnswer(plain, form.questions, {}));
  assert.deepEqual(
    mcpAnswer(plain, form.questions, { confirm: { answers: ["Decline"] } }),
    { action: "decline", content: null, _meta: null },
  );
});
test("MCP questions preserve typed answers and validate native constraints", () => {
  const params = {
    mode: "form",
    message: "Required input",
    requestedSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 2 },
        count: { type: "integer", minimum: 1 },
        ok: { type: "boolean" },
        choice: { type: "string", enum: ["a", "b"] },
      },
      required: ["name", "count", "ok", "choice"],
    },
  };
  assert.throws(
    () =>
      mcpQuestions({
        ...params,
        requestedSchema: { ...params.requestedSchema, required: [] },
      }),
    /Optional/,
  );
  const form = mcpQuestions(params);
  const answers = {
    name: { answers: ["Alex"] },
    count: { answers: ["2"] },
    ok: { answers: ["false"] },
    choice: { answers: ["b"] },
  };
  assert.deepEqual(mcpAnswer(params, form.questions, answers), {
    action: "accept",
    content: { name: "Alex", count: 2, ok: false, choice: "b" },
    _meta: null,
  });
  assert.throws(
    () =>
      mcpAnswer(params, form.questions, {
        ...answers,
        count: { answers: [" "] },
      }),
    /valid/,
  );
  assert.throws(
    () =>
      mcpAnswer(params, form.questions, {
        ...answers,
        count: { answers: ["not a number"] },
      }),
    /number/,
  );
  assert.throws(
    () =>
      mcpQuestions({
        ...params,
        requestedSchema: {
          type: "object",
          properties: { data: { type: "object" } },
          required: ["data"],
        },
      }),
    /Unsupported/,
  );
  const url = {
    mode: "url",
    url: "https://example.com/login",
    message: "Complete sign-in",
  };
  const login = mcpQuestions(url);
  assert.equal(login.url, url.url);
  assert.equal(
    mcpAnswer(url, login.questions, { confirm: { answers: ["Continue"] } })
      .action,
    "accept",
  );
  assert.throws(() => mcpQuestions({ ...url, url: "javascript:alert(1)" }));
});

test("expired reply cleanup preserves other conversations incarnations and effects", async () => {
  const { Store } = await import("../src/server/store.ts");
  const { Runtime } = await import("../src/server/runtime.ts");
  const { homePath } = await import("../src/server/home.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const home = homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-expired-")));
  const store = new Store(home);
  store.fence();
  try {
    const cid = randomUUID();
    const c: any = {
      id: cid,
      provider: "codex",
      model: "fake",
      role: "supervisor",
      cwd: home,
      incarnation: 1,
      state: "idle",
      inputOwner: "automation",
      version: 1,
    };
    store.putConversation(c);
    store.putConversation({ ...c, id: "other" });
    const commandId = randomUUID();
    store.command(
      { kind: "user", id: "test" },
      { commandId, type: "layout.save", payload: {} },
    );
    for (const [id, conversation, incarnation, kind] of [
      ["match", cid, 1, "permission.reply"],
      ["other-conversation", "other", 1, "permission.reply"],
      ["old-incarnation", cid, 2, "permission.reply"],
      ["other-effect", cid, 1, "conversation.send"],
    ] as const) {
      store.db
        .prepare("INSERT INTO permissions VALUES(?,?,?,?)")
        .run(id, conversation, "expired", JSON.stringify({ incarnation }));
      store.db
        .prepare(
          "INSERT INTO outbox(id,command_id,kind,target_id,payload,state,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          commandId,
          kind,
          conversation,
          JSON.stringify({ requestId: id }),
          "uncertain",
          new Date().toISOString(),
        );
    }
    const runtime = new Runtime(store);
    runtime.reconcileExpiredReplies(c);
    runtime.reconcileExpiredReplies(c);
    assert.equal(
      (
        store.db
          .prepare("SELECT state FROM outbox WHERE id='match'")
          .get() as any
      ).state,
      "cancelled",
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT count(*) n FROM outbox WHERE state='uncertain'")
          .get() as any
      ).n,
      3,
    );
    assert.equal(
      (
        store.db
          .prepare(
            "SELECT count(*) n FROM events WHERE type='permission.replyExpired'",
          )
          .get() as any
      ).n,
      1,
    );
  } finally {
    store.db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
