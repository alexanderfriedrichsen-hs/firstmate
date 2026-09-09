import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { collectPullRequests } from "../src/server/github.ts";
const user = { kind: "user" as const, id: "fixture" };
test("every linked PR needs its own current CI and verified merge evidence", async () => {
  const s = new Store(
    homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-pr-"))),
  );
  s.fence();
  s.setting("project", { requiredChecks: ["required-build"] });
  const links = [1, 2].map((n) => ({
    kind: "github_pr",
    url: "https://github.com/example/repo/pull/" + n,
  }));
  const { ticket: t } = s.command(user, {
    commandId: randomUUID(),
    type: "ticket.create",
    payload: { title: "Two PRs", links },
  });
  t.revision = "rev";
  s.putTicket(t);
  s.setting("revision:rev", {
    repository: "https://github.com/example/repo.git",
    head: "head",
    base: "base",
    tree: "tree",
  });
  for (const requirement of ["validation", "review"])
    s.command(
      { kind: "collector", id: "fixture" },
      {
        commandId: randomUUID(),
        type: "evidence.register",
        targetId: t.id,
        expectedVersion: s.ticket(t.id, user).version,
        payload: {
          revision: "rev",
          requirement,
          verdict: "passed",
          provenance: "fixture",
        },
      },
    );
  let secondFails = true;
  let current = 1;
  const api = async (route: string) => {
    if (/\/pulls\/\d+$/.test(route)) {
      current = Number(route.split("/").at(-1));
      return {
        head: { sha: "head" },
        base: { sha: "merged-base" },
        merged: true,
        merge_commit_sha: "merge" + current,
        state: "closed",
      };
    }
    if (route.includes("/git/commits/"))
      return { tree: { sha: "tree" }, parents: [{ sha: "base" }] };
    if (route.includes("check-runs"))
      return {
        total_count: 1,
        check_runs: [
          {
            id: current,
            name: "required-build",
            app: { id: 1 },
            status: "completed",
            conclusion: current === 2 && secondFails ? "failure" : "success",
          },
        ],
      };
    if (route.endsWith("/status"))
      return { total_count: 0, statuses: [], state: "success" };
    return [];
  };
  await collectPullRequests(s, t.id, api);
  assert.notEqual(s.ticket(t.id, user).status, "completed");
  assert.equal(s.detail(t.id, user).closures.length, 0);
  secondFails = false;
  await collectPullRequests(s, t.id, api);
  assert.equal(s.ticket(t.id, user).status, "completed");
  assert.equal(s.detail(t.id, user).closures.length, 1);
  assert.equal(
    s.evidence(t.id).filter((e) => e.requirement.startsWith("merge:")).length,
    3,
  );
  s.db.close();
});
test("unknown required CI configuration cannot become a green check", async () => {
  const s = new Store(
    homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-pr-unknown-"))),
  );
  s.fence();
  const { ticket: t } = s.command(user, {
    commandId: randomUUID(),
    type: "ticket.create",
    payload: {
      title: "Unknown checks",
      links: [
        { kind: "github_pr", url: "https://github.com/example/repo/pull/1" },
      ],
    },
  });
  t.revision = "rev";
  s.putTicket(t);
  s.setting("revision:rev", {
    repository: "https://github.com/example/repo.git",
    head: "head",
    base: "base",
  });
  await collectPullRequests(s, t.id, async (route) =>
    route.endsWith("/pulls/1")
      ? { head: { sha: "head" }, base: { sha: "base" }, merged: false }
      : route.includes("check-runs")
        ? {
            total_count: 1,
            check_runs: [
              {
                id: 1,
                name: "one-observed-check",
                status: "completed",
                conclusion: "success",
              },
            ],
          }
        : route.endsWith("/status")
          ? { total_count: 0, statuses: [], state: "success" }
          : [],
  );
  assert.equal(s.evidence(t.id).at(-1)?.verdict, "unknown");
  s.db.close();
});
