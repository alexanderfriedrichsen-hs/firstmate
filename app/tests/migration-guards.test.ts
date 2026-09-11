import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { Runtime } from "../src/server/runtime.ts";
import { homePath } from "../src/server/home.ts";
const user = { kind: "user" as const, id: "test" };
function fixture() {
  const home = homePath(
    fs.mkdtempSync(path.join(os.tmpdir(), "fm-migration-guards-")),
  );
  const s = new Store(home);
  s.fence();
  s.setting("project", { source: home, remote: "fixture" });
  const t = s.command(user, {
    commandId: randomUUID(),
    type: "ticket.create",
    payload: { title: "Imported queued work" },
  }).ticket;
  s.db.prepare("DELETE FROM wakes").run();
  s.setting("legacy:" + t.id, {
    management: "external",
    metadata: {},
    statusHistory: "",
    holds: [],
  });
  const cmd = (type: string, payload: any = {}, actor: any = user) =>
    s.command(actor, {
      commandId: randomUUID(),
      type,
      targetId: t.id,
      expectedVersion: s.ticket(t.id, user).version,
      payload,
    });
  return {
    s,
    t,
    home,
    cmd,
    close() {
      s.db.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
test("released ownership rejects commands, direct writes, and runtime restart while retaining readable history", () => {
  const f = fixture();
  try {
    f.s.setting("ownershipReleased", { at: new Date().toISOString() });
    assert.throws(
      () => f.cmd("ticket.update", { title: "Forbidden" }),
      /read-only/,
    );
    assert.throws(
      () => f.s.db.prepare("DELETE FROM tickets").run(),
      /readonly/,
    );
    assert.throws(() => new Runtime(f.s).start(), /read-only/);
    assert.equal(f.s.ticket(f.t.id, user).title, "Imported queued work");
    const reopened = new Store(f.home);
    try {
      assert.throws(() => reopened.fence(), /read-only/);
      assert.equal(reopened.tickets(user).length, 1);
    } finally {
      reopened.db.close();
    }
  } finally {
    f.close();
  }
});
test("external tickets cannot create duplicate workers or run managed operations even with a known id", () => {
  const f = fixture();
  try {
    for (const actor of [user, { kind: "supervisor", id: "firstmate" }]) {
      assert.throws(
        () =>
          f.s.command(actor as any, {
            commandId: randomUUID(),
            type: "conversation.create",
            payload: {
              provider: "codex",
              model: "fixture",
              role: "worker",
              ticketId: f.t.id,
            },
          }),
        /externally managed/,
      );
      for (const type of [
        "ticket.validate",
        "ticket.review",
        "ticket.repair",
        "ticket.draftPr",
        "ticket.refreshPr",
        "stage.retry",
        "ticket.claimComplete",
      ])
        assert.throws(() => f.cmd(type, {}, actor), /externally managed/);
    }
    f.cmd("ticket.update", { title: "Manual edit" });
    f.cmd("ticket.complete");
    assert.equal(f.s.ticket(f.t.id, user).status, "completed");
    assert.equal(f.s.conversations(user).length, 0);
  } finally {
    f.close();
  }
});
test("only a user can adopt plain queued legacy work and adoption queues exactly one wake", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.cmd("ticket.adopt", {}, { kind: "supervisor", id: "firstmate" }),
      /not found/,
    );
    f.s.setting("legacy:" + f.t.id, {
      management: "external",
      metadata: { worktree: "/retained" },
    });
    assert.throws(() => f.cmd("ticket.adopt"), /reconciliation/);
    f.s.setting("legacy:" + f.t.id, {
      management: "external",
      metadata: { kind: "change" },
    });
    f.cmd("ticket.adopt");
    assert.equal(f.s.setting("legacy:" + f.t.id).management, "app");
    assert.equal(
      (
        f.s.db
          .prepare("SELECT count(*) n FROM wakes WHERE state='pending'")
          .get() as any
      ).n,
      1,
    );
    assert.throws(() => f.cmd("ticket.adopt"), /externally managed/);
    f.s.command(user, {
      commandId: randomUUID(),
      type: "conversation.create",
      payload: {
        provider: "codex",
        model: "fixture",
        role: "worker",
        ticketId: f.t.id,
      },
    });
    assert.equal(f.s.conversations(user).length, 1);
  } finally {
    f.close();
  }
});
test("automatic wake and retry schedulers ignore external legacy tickets", () => {
  const f = fixture();
  try {
    f.s.setting("policy", { ...f.s.setting("policy"), paused: false });
    f.s.putConversation({
      id: randomUUID(),
      cwd: f.home,
      provider: "codex",
      model: "fixture",
      role: "supervisor",
      state: "idle",
      incarnation: 0,
      inputOwner: "automation",
      version: 1,
    });
    f.s.db
      .prepare("INSERT INTO wakes VALUES(?,?,?,?,?)")
      .run("external", f.t.id, "pending", "{}", new Date().toISOString());
    f.s.db
      .prepare("INSERT INTO retries VALUES(?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        f.t.id,
        null,
        "worker",
        "scheduled",
        new Date(0).toISOString(),
        "{}",
      );
    const runtime = new Runtime(f.s);
    runtime.scheduleWakes();
    runtime.scheduleRetries();
    assert.equal(
      (f.s.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
      0,
    );
  } finally {
    f.close();
  }
});
test("Firstmate can start without a project but workers and adoption require an explicit project", () => {
  const f = fixture();
  try {
    f.s.setting("project", null);
    const result = f.s.command(user, {
      commandId: randomUUID(),
      type: "conversation.create",
      payload: { provider: "codex", model: "fixture", role: "supervisor" },
    });
    assert.equal(result.conversation.cwd, path.join(f.home, "workspace"));
    assert.throws(() => f.cmd("ticket.adopt"), /Configure a project/);
    assert.equal(f.s.detail(f.t.id, user).adoption?.eligible, false);
    f.s.setting("legacy:" + f.t.id, { management: "app" });
    assert.throws(
      () =>
        f.s.command(user, {
          commandId: randomUUID(),
          type: "conversation.create",
          payload: {
            provider: "codex",
            model: "fixture",
            role: "worker",
            ticketId: f.t.id,
          },
        }),
      /Configure a project/,
    );
  } finally {
    f.close();
  }
});
test("conflicting imported worker metadata blocks adoption even if previous metadata was empty", () => {
  const f = fixture();
  try {
    f.s.setting("migration-conflict:" + f.t.id, {
      metadata: { worktree: "/retained/worker" },
    });
    assert.throws(() => f.cmd("ticket.adopt"), /conflicting legacy updates/);
    assert.equal(f.s.setting("legacy:" + f.t.id).management, "external");
  } finally {
    f.close();
  }
});
test("returned or ambiguous conversation leases cannot resume from a guessed id", () => {
  const f = fixture();
  try {
    const id = randomUUID();
    f.s.putConversation({
      id,
      cwd: f.home,
      provider: "codex",
      model: "fixture",
      role: "worker",
      state: "parked",
      incarnation: 0,
      inputOwner: "user",
      version: 1,
    });
    f.s.setting("lease-retirement-intent:conversation:" + id, {
      reportId: "reviewed",
    });
    assert.throws(
      () =>
        f.s.command(user, {
          commandId: randomUUID(),
          type: "conversation.resume",
          targetId: id,
          expectedVersion: 1,
          payload: {},
        }),
      /lease retirement/,
    );
  } finally {
    f.close();
  }
});

test("queued legacy adoption rejects a different explicit repository hint", () => {
  const f = fixture();
  try {
    f.s.setting("project", {
      source: "/projects/firstmate",
      remote: "git@github.com:example/firstmate.git",
    });
    f.s.setting("legacy:" + f.t.id, {
      management: "external",
      metadata: {},
      raw: "- [ ] queued-task - Fix delivery (repo: joinera)",
    });
    assert.equal(
      f.s.adoptionEligibility(f.s.ticket(f.t.id, user)).eligible,
      false,
    );
    assert.throws(
      () => f.cmd("ticket.adopt"),
      /repository.*configured project/i,
    );
    assert.equal(f.s.setting("legacy:" + f.t.id).management, "external");
    f.s.setting("project", {
      source: "/projects/joinera",
      remote: "git@github.com:joinhandshake/joinera.git",
    });
    assert.equal(
      f.s.adoptionEligibility(f.s.ticket(f.t.id, user)).eligible,
      true,
    );
    f.s.setting("legacy:" + f.t.id, {
      management: "external",
      metadata: {},
      raw: "- [ ] queued-task - Fix delivery (repo: another-owner/joinera)",
    });
    assert.equal(
      f.s.adoptionEligibility(f.s.ticket(f.t.id, user)).eligible,
      false,
    );
  } finally {
    f.s.db.close();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
