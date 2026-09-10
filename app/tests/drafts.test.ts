import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { assertDraftCurrent } from "../src/server/drafts.ts";

test("publication rechecks lifecycle, revision, and writer ownership after remote reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-draft-"));
  const s = new Store(homePath(root));
  s.fence();
  try {
    const { ticket: t } = s.command(
      { kind: "user", id: "fixture" },
      {
        commandId: randomUUID(),
        type: "ticket.create",
        payload: { title: "Draft race" },
      },
    );
    t.revision = "original";
    s.putTicket(t);
    s.setting("writerReservation:" + t.id, { commandId: "publication" });
    assert.equal(
      assertDraftCurrent(s, t.id, "original", "publication").id,
      t.id,
    );
    for (const patch of [
      { handling: "human_only" },
      { status: "completed" },
      { revision: "new" },
    ]) {
      s.putTicket({ ...t, ...patch });
      assert.throws(
        () => assertDraftCurrent(s, t.id, "original", "publication"),
        /changed/,
      );
    }
    s.putTicket(t);
    s.setting("writerReservation:" + t.id, { commandId: "replacement" });
    assert.throws(
      () => assertDraftCurrent(s, t.id, "original", "publication"),
      /changed/,
    );
  } finally {
    s.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { execFileSync } from "node:child_process";
import { launchDraft, collectDraft } from "../src/server/drafts.ts";

function publicationFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-publication-"));
  const s = new Store(homePath(path.join(root, "home")));
  s.fence();
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "draft-test");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", head);
  const { ticket: t } = s.command(
    { kind: "user", id: "fixture" },
    {
      commandId: randomUUID(),
      type: "ticket.create",
      payload: { title: "Publication fixture" },
    },
  );
  t.revision = "frozen";
  s.putTicket(t);
  const cid = randomUUID();
  s.putConversation({
    id: cid,
    ticketId: t.id,
    provider: "codex",
    model: "fixture",
    role: "worker",
    cwd,
    incarnation: 1,
    state: "idle",
    inputOwner: "automation",
    version: 1,
  });
  s.setting("project", {
    remote: "https://github.com/joinhandshake/joinera.git",
  });
  s.setting("revision:frozen", { head, base: head });
  s.setting("revision-source:frozen", { conversationId: cid, cwd });
  s.db
    .prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?,?)")
    .run(
      randomUUID(),
      t.id,
      "frozen",
      "validation",
      "passed",
      "{}",
      new Date().toISOString(),
    );
  const job = {
    id: randomUUID(),
    target_id: t.id,
    command_id: randomUUID(),
    payload: JSON.stringify({
      title: "Fixture draft",
      body: "A sufficiently long fixture body.",
    }),
  };
  s.setting("writerReservation:" + t.id, { commandId: job.command_id });
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  // All gh calls terminate in this local stub; no GitHub credentials or network are used.
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(path.join(root, "queried"))}, 'yes');\nconst wait = () => { if (!fs.existsSync(${JSON.stringify(path.join(root, "release"))})) return setTimeout(wait, 5); process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(root, "response"))})); }; wait();\n`,
    { mode: 0o700 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  async function remote(
    response: unknown,
    action: () => Promise<unknown>,
    duringRead = () => {},
  ) {
    fs.rmSync(path.join(root, "queried"), { force: true });
    fs.rmSync(path.join(root, "release"), { force: true });
    fs.writeFileSync(path.join(root, "response"), JSON.stringify(response));
    const pending = action();
    const settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    for (let i = 0; !fs.existsSync(path.join(root, "queried")); i++) {
      if (i > 500) throw new Error("Fake gh was not invoked");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    duringRead();
    fs.writeFileSync(path.join(root, "release"), "yes");
    const result = await settled;
    if ("error" in result) throw result.error;
    return result.value;
  }
  function resultJob() {
    const key = "draft:" + job.id;
    s.setting(key, {
      id: job.id,
      ticketId: t.id,
      revision: t.revision,
      head,
      cwd,
      branch: "draft-test",
      state: "running",
      commandId: job.command_id,
    });
    const dir = path.join(s.home, "app", "drafts", job.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({ id: job.id, revision: t.revision, passed: true }),
    );
    fs.writeFileSync(path.join(dir, "draft.log"), "Local fixture result");
    return key;
  }
  return {
    s,
    t,
    job,
    head,
    root,
    remote,
    resultJob,
    close() {
      process.env.PATH = oldPath;
      s.db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("draft dispatch refuses an existing ready PR and lifecycle races before spawning", async () => {
  for (const race of ["ready", "cancelled", "reservation", "owner"]) {
    const f = publicationFixture();
    try {
      await assert.rejects(
        f.remote(
          race === "ready" ? [{ isDraft: false }] : [],
          () => launchDraft(f.s, f.job),
          () => {
            if (race === "owner") f.s.setting("generation", f.s.generation + 1);
            if (race === "cancelled")
              f.s.putTicket({ ...f.t, status: "cancelled" });
            if (race === "reservation")
              f.s.setting("writerReservation:" + f.t.id, {
                commandId: "replacement",
              });
          },
        ),
        /non-draft PR|changed|Stale runtime generation/,
      );
      assert.equal(f.s.setting("draft:" + f.job.id), null);
      assert.equal(
        fs.existsSync(path.join(f.s.home, "app", "drafts", f.job.id)),
        false,
      );
    } finally {
      f.close();
    }
  }
});

test("draft collection requires matching remote draft HEAD and current ticket ownership", async () => {
  for (const variant of [
    "ready",
    "head",
    "cancelled",
    "reservation",
    "owner",
    "valid",
  ]) {
    const f = publicationFixture();
    try {
      const key = f.resultJob();
      const url = "https://github.com/joinhandshake/joinera/pull/123";
      const pending = f.remote(
        {
          url,
          isDraft: variant !== "ready",
          headRefOid: variant === "head" ? "other" : f.head,
        },
        () => collectDraft(f.s, key),
        () => {
          if (variant === "owner")
            f.s.setting("generation", f.s.generation + 1);
          if (variant === "cancelled")
            f.s.putTicket({ ...f.t, status: "cancelled" });
          if (variant === "reservation")
            f.s.setting("writerReservation:" + f.t.id, {
              commandId: "replacement",
            });
        },
      );
      if (variant === "valid") {
        await pending;
        assert.equal(f.s.setting(key).state, "completed");
        assert.equal(
          f.s.ticket(f.t.id, { kind: "user", id: "fixture" }).links[0].url,
          url,
        );
        assert.equal(f.s.setting("writerReservation:" + f.t.id), null);
      } else {
        await assert.rejects(
          pending,
          /Remote PR differs|changed|Stale runtime generation/,
        );
        assert.equal(f.s.setting(key).state, "running");
        assert.deepEqual(
          f.s.ticket(f.t.id, { kind: "user", id: "fixture" }).links,
          [],
        );
        assert.ok(f.s.setting("writerReservation:" + f.t.id));
      }
    } finally {
      f.close();
    }
  }
});

test("a pending draft reservation prevents a second draft command", () => {
  const f = publicationFixture();
  try {
    assert.throws(
      () =>
        f.s.command(
          { kind: "user", id: "fixture" },
          {
            commandId: randomUUID(),
            type: "ticket.draftPr",
            targetId: f.t.id,
            expectedVersion: f.t.version,
            payload: JSON.parse(f.job.payload),
          },
        ),
      /reserved writer/,
    );
    assert.equal(
      f.s.setting("writerReservation:" + f.t.id).commandId,
      f.job.command_id,
    );
    assert.equal(
      (
        f.s.db
          .prepare(
            "SELECT count(*) AS n FROM outbox WHERE kind='ticket.draftPr'",
          )
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    f.close();
  }
});
