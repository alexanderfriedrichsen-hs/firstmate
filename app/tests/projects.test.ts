import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { ticketProject } from "../src/server/projects.ts";
import { Runtime } from "../src/server/runtime.ts";
const actor = { kind: "user" as const, id: "test" };
function fixture() {
  const store = new Store(
    homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-projects-"))),
  );
  store.fence();
  const repo = (id: string, remote: string) => {
    const cwd = path.join(store.home, "projects", id);
    fs.mkdirSync(cwd, { recursive: true });
    childProcess.execFileSync("git", ["init", "-q"], { cwd });
    childProcess.execFileSync("git", ["remote", "add", "origin", remote], {
      cwd,
    });
    return cwd;
  };
  const firstmate = repo("firstmate", "https://github.com/example/firstmate");
  const joinera = repo("joinera", "https://github.com/joinhandshake/joinera");
  fs.mkdirSync(path.join(store.home, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(store.home, "data/projects.md"),
    "- joinera [draft-pr-adapter] - project\n",
  );
  store.setting("project", {
    source: firstmate,
    remote: "https://github.com/example/firstmate",
    profile: "code_only",
    requiredChecks: ["firstmate-ci"],
  });
  store.setting("providerModelCatalog.codex", [{ model: "test" }]);
  const command = (type: string, payload: any, target?: any) =>
    store.command(actor, {
      commandId: randomUUID(),
      type,
      payload,
      targetId: target?.id,
      expectedVersion: target?.version,
    });
  return {
    store,
    firstmate,
    joinera,
    command,
    close() {
      store.db.close();
      fs.rmSync(store.home, { recursive: true, force: true });
    },
  };
}
test("FM-83 PR brief resolves Joinera instead of the default Firstmate repository", () => {
  const f = fixture();
  try {
    const project = ticketProject(f.store, {
      brief:
        "Resolve https://github.com/joinhandshake/joinera/pull/20073 on fm/rolloutblock-obs-i2-c",
      links: [],
    });
    assert.equal(project.id, "joinera");
    assert.equal(project.source, f.joinera);
    assert.deepEqual(project.requiredChecks, []);
    assert.throws(
      () => ticketProject(f.store, { brief: "Unspecified", links: [] }),
      /Multiple projects/,
    );
    assert.throws(
      () =>
        ticketProject(f.store, {
          brief: "https://github.com/other/joinera/pull/1",
          links: [],
        }),
      /unavailable or ambiguous/,
    );
    assert.throws(
      () =>
        ticketProject(f.store, { projectId: "missing", brief: "", links: [] }),
      /Unknown or unavailable/,
    );
    assert.equal(
      ticketProject(f.store, { projectId: "default", brief: "", links: [] })
        .source,
      f.firstmate,
    );
  } finally {
    f.close();
  }
});
test("project changes preserve old worker identity and require a new settled worker", () => {
  const f = fixture();
  try {
    const t = f.command("ticket.create", {
      title: "Repair",
      projectId: "default",
    }).ticket;
    const old = f.command("conversation.create", {
      role: "worker",
      ticketId: t.id,
      provider: "codex",
      model: "test",
    }).conversation;
    assert.equal(old.cwd, f.firstmate);
    assert.throws(
      () => f.command("ticket.update", { projectId: "joinera" }, t),
      /Park and settle/,
    );
    old.state = "parked";
    f.store.putConversation(old);
    f.store.db.prepare("UPDATE outbox SET state='accepted'").run();
    const updated = f.command(
      "ticket.update",
      { projectId: "joinera" },
      t,
    ).ticket;
    assert.throws(
      () => f.command("conversation.resume", {}, old),
      /previous project/,
    );
    const next = f.command("conversation.create", {
      role: "worker",
      ticketId: t.id,
      provider: "codex",
      model: "test",
    }).conversation;
    assert.equal(next.cwd, f.joinera);
    assert.equal(f.store.projectForConversation(old).source, f.firstmate);
    assert.equal(f.store.projectForConversation(next).source, f.joinera);
    assert.equal(f.store.detail(updated.id, actor).project?.id, "joinera");
    f.store.setting("project", { source: "/changed", remote: "changed" });
    assert.equal(f.store.projectForTicket(updated).source, f.joinera);
    // Review and repair use the selected ticket repository too.
    updated.revision = "revision";
    f.store.putTicket(updated);
    f.store.setting("revision:revision", { head: "fake" });
    const review = f.command(
      "ticket.review",
      { model: "test" },
      updated,
    ).ticket;
    assert.equal(
      f.store.conversations(actor).find((c) => c.stage === "review")?.cwd,
      f.joinera,
    );
  } finally {
    f.close();
  }
});
test("runtime allocates in selected project and rejects a mismatched Treehouse lease", async (t) => {
  const f = fixture();
  const original = childProcess.execFileSync;
  const calls: any[] = [];
  let wrong = false;
  try {
    const bin = path.join(f.store.home, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o700 });
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    t.after(() => {
      process.env.PATH = oldPath;
    });
    t.mock.method(childProcess, "execFileSync", ((
      file: string,
      args: string[],
      options: any,
    ) => {
      if (file === "treehouse") {
        calls.push({ args, cwd: options.cwd });
        return JSON.stringify({
          path: wrong ? f.firstmate : f.joinera,
          lease_id: "lease",
          lease_holder: "holder",
        });
      }
      return (original as any)(file, args, options);
    }) as any);
    t.mock.method(childProcess, "execFile", ((
      file: string,
      args: string[],
      options: any,
      callback: any,
    ) => {
      if (file !== "treehouse") throw new Error("Unexpected async command");
      calls.push({ args, cwd: options.cwd });
      callback(
        null,
        JSON.stringify({
          path: wrong ? f.firstmate : f.joinera,
          lease_id: "lease",
          lease_holder: "holder",
        }),
        "",
      );
      return {};
    }) as any);

    t.mock.method(childProcess, "spawn", (() => ({ unref() {} })) as any);
    syncBuiltinESMExports();
    const ticket = f.command("ticket.create", {
      title: "Repair",
      projectId: "joinera",
    }).ticket;
    const create = () =>
      f.command("conversation.create", {
        role: "worker",
        ticketId: ticket.id,
        provider: "codex",
        model: "test",
      }).conversation;
    f.store.setting("policy", { ...f.store.setting("policy"), paused: false });
    const c = create();
    await new Runtime(f.store).launch(c);
    assert.equal(calls[0].cwd, f.joinera);
    assert.equal(c.cwd, f.joinera);
    assert.equal(f.store.setting("lease:" + c.id).source, f.joinera);
    wrong = true;
    await assert.rejects(
      new Runtime(f.store).launch(create()),
      /Allocated repository identity differs/,
    );
    for (const change of ["pause", "takeover", "send"]) {
      let respond: any;
      t.mock.method(childProcess, "execFile", ((
        _file: any,
        _args: any,
        _options: any,
        callback: any,
      ) => {
        respond = callback;
        return {};
      }) as any);
      syncBuiltinESMExports();
      const delayed = create();
      const pending = new Runtime(f.store).launch(delayed);
      if (change === "pause")
        f.store.setting("policy", {
          ...f.store.setting("policy"),
          paused: true,
        });
      else
        f.command(
          change === "takeover" ? "conversation.takeover" : "conversation.send",
          change === "send" ? { text: "Supplement" } : {},
          delayed,
        );
      const version = f.store.conversation(delayed.id, actor).version;
      respond(
        null,
        JSON.stringify({
          path: f.joinera,
          lease_id: "late",
          lease_holder: "firstmate-attempt-" + delayed.id,
        }),
        "",
      );
      if (change === "send") {
        await pending;
        assert.equal(
          f.store.conversation(delayed.id, actor).version,
          version + 1,
        );
      } else {
        await assert.rejects(pending, /control changed/);
        assert.equal(f.store.conversation(delayed.id, actor).version, version);
        assert.equal(
          f.store.conversation(delayed.id, actor).runnerId,
          undefined,
        );
      }
      assert.equal(f.store.setting("lease:" + delayed.id).lease_id, "late");
      f.store.setting("policy", {
        ...f.store.setting("policy"),
        paused: false,
      });
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});
test("unregistered and escaping clone symlinks do not become allocatable", () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.store.projects().map((p) => p.id),
      ["default", "joinera"],
    );
    fs.appendFileSync(
      path.join(f.store.home, "data/projects.md"),
      "- escape [direct-PR] - bad\n",
    );
    fs.symlinkSync(f.firstmate, path.join(f.store.home, "projects/escape"));
    assert.deepEqual(
      f.store.projects().map((p) => p.id),
      ["default", "joinera"],
    );
  } finally {
    f.close();
  }
});

test("adoption resolves a registered project and retains the binding after import", () => {
  const f = fixture();
  try {
    const t = f.command("ticket.create", {
      title: "Imported",
      brief: "",
    }).ticket;
    f.store.setting("legacy:" + t.id, {
      management: "external",
      raw: "(repo: joinera)",
      metadata: {},
    });
    assert.equal(f.store.adoptionEligibility(t).eligible, true);
    const adopted = f.command("ticket.adopt", {}, t).ticket;
    assert.equal(adopted.projectId, "joinera");
    assert.equal(f.store.projectForTicket(adopted).source, f.joinera);
  } finally {
    f.close();
  }
});

test("independent checks allocate from the ticket project and select its validation adapter", async (t) => {
  const f = fixture();
  const original = childProcess.execFileSync;
  const allocations: string[] = [];
  const previousAdapter = process.env.FIRSTMATE_JOINERA_ADAPTER;
  try {
    const adapter = path.join(f.store.home, "adapter");
    fs.writeFileSync(adapter, "#!/bin/sh\n", { mode: 0o700 });
    process.env.FIRSTMATE_JOINERA_ADAPTER = adapter;
    original(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: f.joinera, stdio: "ignore" },
    );
    original("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
      cwd: f.joinera,
    });
    const tkt = f.command("ticket.create", {
      title: "Check",
      projectId: "joinera",
    }).ticket;
    const c = f.command("conversation.create", {
      role: "worker",
      ticketId: tkt.id,
      provider: "codex",
      model: "test",
    }).conversation;
    c.state = "idle";
    f.store.putConversation(c);
    f.store.db.prepare("UPDATE outbox SET state='accepted'").run();
    t.mock.method(childProcess, "execFileSync", ((
      file: string,
      args: string[],
      options: any,
    ) => {
      if (file === "treehouse") {
        allocations.push(options.cwd);
        return JSON.stringify({
          path: f.joinera,
          lease_id: "check-lease",
          lease_holder: "check",
        });
      }
      return (original as any)(file, args, options);
    }) as any);
    t.mock.method(childProcess, "spawn", (() => ({ unref() {} })) as any);
    syncBuiltinESMExports();
    const { launchChecks } = await import("../src/server/checks.ts");
    const jobId = randomUUID();
    launchChecks(f.store, tkt.id, jobId);
    const job = f.store.setting("check:" + jobId);
    assert.deepEqual(allocations, [f.joinera]);
    assert.equal(job.commands[0].executable, adapter);
    assert.equal(job.project.id, "joinera");
    assert.equal(job.lease.source, f.joinera);
    assert.equal(
      f.store.projectChecks(f.store.ticket(tkt.id, actor)).length,
      0,
    );
  } finally {
    if (previousAdapter === undefined)
      delete process.env.FIRSTMATE_JOINERA_ADAPTER;
    else process.env.FIRSTMATE_JOINERA_ADAPTER = previousAdapter;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test("explicit and pinned projects reject contradictory repository associations but permit incidental prose", () => {
  const f = fixture();
  try {
    const linked = {
      projectId: "default",
      brief: "",
      links: [
        {
          kind: "github_pr",
          url: "https://github.com/joinhandshake/joinera/pull/1",
        },
      ],
    };
    assert.throws(() => ticketProject(f.store, linked), /contradicts/);
    assert.throws(
      () =>
        ticketProject(f.store, {
          projectId: "default",
          brief: "(repo: joinera)",
          links: [],
        }),
      /contradicts/,
    );
    assert.equal(
      ticketProject(f.store, {
        projectId: "default",
        brief:
          "Related context: https://github.com/joinhandshake/joinera/pull/1",
        links: [],
      }).id,
      "default",
    );
    assert.equal(
      ticketProject(f.store, { brief: `(repo: ${f.firstmate})`, links: [] }).id,
      "default",
    );
    const t = f.command("ticket.create", {
      title: "Pinned",
      projectId: "default",
    }).ticket;
    f.command("conversation.create", {
      role: "worker",
      ticketId: t.id,
      provider: "codex",
      model: "test",
    });
    assert.throws(
      () => f.store.projectForTicket({ ...t, links: linked.links }),
      /contradicts/,
    );
    assert.throws(
      () =>
        ticketProject(f.store, {
          brief:
            "https://github.com/example/firstmate/pull/1 https://github.com/joinhandshake/joinera/pull/2",
          links: [],
        }),
      /ambiguous/,
    );
  } finally {
    f.close();
  }
});

test("draft publication refuses a source checkout whose origin differs from the bound project", async () => {
  const f = fixture();
  try {
    const t = f.command("ticket.create", {
      title: "Draft",
      projectId: "joinera",
    }).ticket;
    const c = f.command("conversation.create", {
      role: "worker",
      ticketId: t.id,
      provider: "codex",
      model: "test",
    }).conversation;
    c.cwd = f.firstmate;
    c.state = "idle";
    f.store.putConversation(c);
    t.revision = "frozen";
    f.store.putTicket(t);
    f.store.setting("revision:frozen", { head: "head", base: "base" });
    f.store.setting("revision-source:frozen", {
      conversationId: c.id,
      cwd: c.cwd,
    });
    const { launchDraft } = await import("../src/server/drafts.ts");
    await assert.rejects(
      launchDraft(f.store, { target_id: t.id, payload: "{}" }),
      /Draft source repository differs/,
    );
  } finally {
    f.close();
  }
});
