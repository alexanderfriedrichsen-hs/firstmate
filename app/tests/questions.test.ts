import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuestions,
  validateQuestionAnswers,
  claudeQuestionInput,
  claudeToolHandler,
  codexApproval,
  fullAccessThread,
  fullAccessTurn,
  fullAccessClaude,
  fullAccessCursorArgs,
} from "../src/server/questions.ts";

test("full access policies configure native execution and preserve typed Codex grants", () => {
  assert.deepEqual(fullAccessThread, {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(fullAccessTurn, {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  assert.deepEqual(fullAccessClaude, {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
  assert.ok(fullAccessCursorArgs.includes("--force"));
  assert.ok(fullAccessCursorArgs.includes("disabled"));
  assert.deepEqual(
    codexApproval("item/permissions/requestApproval", {
      permissions: { network: { enabled: true }, fileSystem: null },
    }),
    { permissions: { network: { enabled: true } }, scope: "session" },
  );
  assert.equal(codexApproval("item/tool/requestUserInput", {}), undefined);
});
test("question answers retain native IDs, free text and multi selections without guessing", () => {
  const input = {
    questions: [
      {
        question: "Pick frameworks",
        header: "Frameworks",
        multiSelect: true,
        options: [{ label: "React" }, { label: "Vue" }],
      },
    ],
  };
  const questions = normalizeQuestions("claude", input);
  assert.deepEqual(
    claudeQuestionInput(input, questions, { q0: { answers: ["React", "Vue"] } })
      .answers,
    { "Pick frameworks": "React, Vue" },
  );
  const free = normalizeQuestions("codex", {
    questions: [
      {
        id: "details",
        question: "What do you need?",
        options: null,
        isOther: false,
      },
    ],
  });
  assert.deepEqual(
    validateQuestionAnswers(free, { details: { answers: ["Keep history"] } }),
    { details: { answers: ["Keep history"] } },
  );
  for (const answers of [
    {},
    { details: { answers: [] } },
    { details: { answers: ["a", "b"] } },
    { details: { answers: ["a"] }, unknown: { answers: ["b"] } },
  ])
    assert.throws(() => validateQuestionAnswers(free, answers));
});
test("Claude bypass auto-allows tools but its question callback waits for user input", async () => {
  let finish: any;
  let calls = 0;
  const handler = claudeToolHandler(async () => {
    calls++;
    return await new Promise((resolve) => (finish = resolve));
  });
  const options: any = {
    signal: new AbortController().signal,
    toolUseID: "tool",
  };
  assert.deepEqual(await handler("Bash", { command: "pwd" }, options), {
    behavior: "allow",
    updatedInput: { command: "pwd" },
  });
  let answered = false;
  const waiting = handler("AskUserQuestion", { questions: [] }, options).then(
    (result) => {
      answered = true;
      return result;
    },
  );
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(answered, false);
  finish({
    behavior: "allow",
    updatedInput: { answers: { question: "human answer" } },
  });
  assert.equal((await waiting)?.behavior, "allow");
});

test("question replies validate atomically and stale runners retain interruption controls", async () => {
  const { Store } = await import("../src/server/store.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-question-store-"));
  fs.mkdirSync(path.join(home, "app"));
  const store = new Store(home);
  store.fence();
  const user = { kind: "user" as const, id: "test" };
  const command = (type: string, payload: any, conversation?: any) =>
    store.command(user, {
      commandId: randomUUID(),
      type,
      payload,
      targetId: conversation?.id,
      expectedVersion: conversation?.version,
    });
  try {
    const c = command("conversation.create", {
      provider: "codex",
      model: "fake",
      role: "supervisor",
    }).conversation;
    c.state = "waiting_permission";
    store.putConversation(c);
    const questions = normalizeQuestions("codex", {
      questions: [
        {
          id: "q",
          question: "Choose",
          options: [{ label: "A" }],
          isOther: false,
        },
      ],
    });
    const id = randomUUID();
    store.db.prepare("INSERT INTO permissions VALUES(?,?,?,?)").run(
      id,
      c.id,
      "pending",
      JSON.stringify({
        id,
        kind: "question",
        questions,
        incarnation: c.incarnation,
      }),
    );
    assert.throws(
      () =>
        command(
          "permission.reply",
          { requestId: id, answers: { q: { answers: ["unknown"] } } },
          c,
        ),
      /offered/,
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT state FROM permissions WHERE id=?")
          .get(id) as any
      ).state,
      "pending",
    );
    assert.equal(store.conversation(c.id, user).version, c.version);
    command(
      "permission.reply",
      { requestId: id, answers: { q: { answers: ["A"] } } },
      c,
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT state FROM permissions WHERE id=?")
          .get(id) as any
      ).state,
      "answering",
    );
    assert.throws(
      () =>
        command(
          "permission.reply",
          { requestId: id, answers: { q: { answers: ["A"] } } },
          store.conversation(c.id, user),
        ),
      /expired/,
    );
    store.db
      .prepare(
        "UPDATE outbox SET state='accepted' WHERE kind='permission.reply'",
      )
      .run();
    const current = store.conversation(c.id, user);
    current.runnerId = "old";
    current.state = "idle";
    store.putConversation(current);
    fs.mkdirSync(path.join(home, "app/runners/old"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "app/runners/old/config.json"),
      JSON.stringify({ runnerProtocol: 4 }),
    );
    assert.throws(
      () => command("conversation.send", { text: "hello" }, current),
      /Park and resume/,
    );
    current.state = "waiting_permission";
    store.putConversation(current);
    assert.doesNotThrow(() => command("conversation.interrupt", {}, current));
  } finally {
    store.db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("malformed question display fields and ambiguous Claude text fail before rendering", () => {
  const good = { id: "a", question: "Pick", options: [{ label: "A" }] };
  for (const bad of [
    { ...good, header: {} },
    { ...good, options: {} },
    { ...good, options: [null] },
    { ...good, options: [{ label: "A", description: {} }] },
  ])
    assert.throws(
      () => normalizeQuestions("codex", { questions: [bad] }),
      /invalid/,
    );
  assert.throws(
    () => normalizeQuestions("claude", { questions: [good, good] }),
    /duplicate question text/,
  );
});
