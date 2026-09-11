import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { observeExternalPr } from "../src/server/external-pr.ts";
const user = { kind: "user" as const, id: "fixture" };
function fixture() {
  const home = homePath(
    fs.mkdtempSync(path.join(os.tmpdir(), "fm-external-pr-")),
  );
  const store = new Store(home);
  store.fence();
  const ticket = store.command(user, {
    commandId: randomUUID(),
    type: "ticket.create",
    payload: {
      title: "Retained external worker",
      links: [
        { kind: "github_pr", url: "https://github.com/example/repo/pull/12" },
      ],
    },
  }).ticket;
  store.setting("legacy:" + ticket.id, {
    management: "external",
    metadata: { worktree: "/retained/external" },
  });
  store.db.prepare("DELETE FROM wakes").run();
  const wakes = () =>
    (store.db.prepare("SELECT state,data FROM wakes").all() as any[]).map(
      (row) => ({ state: row.state, ...JSON.parse(row.data) }),
    );
  const artifacts = () =>
    (store.db.prepare("SELECT count(*) n FROM artifacts").get() as any).n;
  return {
    home,
    store,
    ticket,
    wakes,
    artifacts,
    close: () => {
      store.db.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
const open = {
  state: "open",
  merged: false,
  draft: false,
  head: { sha: "head-a" },
};
test("external PR facts deduplicate and preserve ownership and ticket lifecycle", async () => {
  const f = fixture();
  try {
    const before = f.store.ticket(f.ticket.id, user);
    let calls = 0;
    const api = async (route: string) => {
      calls++;
      assert.equal(route, "repos/example/repo/pulls/12");
      return open;
    };
    await observeExternalPr(f.store, f.ticket.id, api);
    await observeExternalPr(f.store, f.ticket.id, api);
    assert.equal(calls, 2);
    assert.equal(f.artifacts(), 1);
    assert.equal(f.wakes().length, 1);
    assert.equal(f.wakes()[0].kind, "external.prChanged");
    assert.equal(f.wakes()[0].observationOnly, true);
    const artifact = fs.readFileSync(
      path.join(f.home, "app", "objects", f.wakes()[0].artifactId),
      "utf8",
    );
    assert.equal(JSON.parse(artifact).head, "head-a");
    await observeExternalPr(f.store, f.ticket.id, async () => ({
      ...open,
      state: "closed",
      merged: true,
      head: { sha: "head-b" },
    }));
    assert.equal(f.artifacts(), 2);
    assert.equal(f.wakes().length, 2);
    assert.deepEqual(f.store.ticket(f.ticket.id, user), before);
    assert.equal(f.store.externallyManaged(f.ticket.id), true);
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM evidence").get() as any).n,
      0,
    );
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM closures").get() as any).n,
      0,
    );
    assert.equal(
      (f.store.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
      0,
    );
  } finally {
    f.close();
  }
});
test("external PR changes are re-notified when facts return to a previously handled state", async () => {
  const f = fixture();
  try {
    await observeExternalPr(f.store, f.ticket.id, async () => open);
    f.store.db.prepare("UPDATE wakes SET state='handled'").run();
    await observeExternalPr(f.store, f.ticket.id, async () => ({
      ...open,
      draft: true,
    }));
    f.store.db.prepare("UPDATE wakes SET state='handled'").run();
    await observeExternalPr(f.store, f.ticket.id, async () => open);
    assert.equal(f.wakes().filter((w) => w.state === "pending").length, 1);
  } finally {
    f.close();
  }
});
test("external PR observation rejects stale ownership or privacy and discards changed associations", async () => {
  for (const drift of [
    "generation",
    "privacy",
    "links",
    "ownership",
    "completed",
    "cancelled",
  ] as const) {
    const f = fixture();
    try {
      const observation = observeExternalPr(f.store, f.ticket.id, async () => {
        const ticket = f.store.ticket(f.ticket.id, user);
        if (drift === "generation")
          f.store.setting("generation", f.store.generation + 1);
        if (drift === "privacy")
          f.store.putTicket({ ...ticket, handling: "human_only" });
        if (drift === "links") f.store.putTicket({ ...ticket, links: [] });
        if (drift === "ownership")
          f.store.setting("legacy:" + ticket.id, { management: "app" });
        if (drift === "completed" || drift === "cancelled")
          f.store.putTicket({ ...ticket, status: drift });
        return open;
      });
      if (drift === "generation" || drift === "privacy")
        await assert.rejects(observation);
      else await observation;
      assert.equal(f.artifacts(), 0, drift);
      assert.equal(f.wakes().length, 0, drift);
    } finally {
      f.close();
    }
  }
});
test("invalid links and incomplete API facts produce no external observations", async () => {
  const f = fixture();
  try {
    const ticket = f.store.ticket(f.ticket.id, user);
    for (const url of [
      "http://github.com/example/repo/pull/12",
      "https://evil.example/example/repo/pull/12",
      "https://github.com/example/repo/issues/12",
    ]) {
      f.store.putTicket({ ...ticket, links: [{ kind: "github_pr", url }] });
      await assert.rejects(
        observeExternalPr(f.store, ticket.id, async () => {
          throw Error("API must not run for invalid associations");
        }),
        /Invalid external PR/,
      );
    }
    f.store.putTicket(ticket);
    await assert.rejects(
      observeExternalPr(f.store, ticket.id, async () => ({ state: "open" })),
      /Incomplete/,
    );
    f.store.putTicket({ ...ticket, handling: "human_only" });
    await assert.rejects(
      observeExternalPr(f.store, ticket.id, async () => {
        throw Error("Private ticket must not query API");
      }),
      /not found/,
    );
    assert.equal(f.artifacts(), 0);
    assert.equal(f.wakes().length, 0);
  } finally {
    f.close();
  }
});
