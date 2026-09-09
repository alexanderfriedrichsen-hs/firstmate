import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import {
  prepareLeaseRetirement,
  executeLeaseRetirement,
  type LeaseCommand,
  type RetirementRequest,
} from "../src/server/leases.ts";
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "fm-lease-test-")),
  );
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(cwd, "file"), "preserve\n");
  git("add", "file");
  git("commit", "-m", "Initial");
  git("remote", "add", "origin", root + "/remote");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const s = new Store(homePath(path.join(root, "home")));
  s.fence();
  s.setting("project", { source: cwd, remote: root + "/remote" });
  s.putConversation({
    id: "worker",
    cwd,
    model: "fixture",
    provider: "codex",
    role: "worker",
    state: "parked",
    incarnation: 0,
    inputOwner: "user",
    version: 1,
  });
  s.setting("lease:worker", {
    path: cwd,
    lease_id: "exact-lease",
    lease_holder: "exact-holder",
  });
  const pool = [
    {
      path: cwd,
      status: "leased",
      lease_id: "exact-lease",
      lease_holder: "exact-holder",
      processes: [] as any[],
    },
  ];
  const calls: string[][] = [];
  const run: LeaseCommand = (args) => {
    calls.push(args);
    return args[0] === "status" ? JSON.stringify(pool) : "";
  };
  const request: RetirementRequest = {
    kind: "conversation",
    targetId: "worker",
    landedRef: "refs/remotes/origin/main",
  };
  return {
    s,
    cwd,
    root,
    git,
    pool,
    calls,
    run,
    request,
    close() {
      s.db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
test("lease retirement prepares without mutation and returns only the exact landed lease", () => {
  const f = fixture();
  try {
    const report = prepareLeaseRetirement(f.s, f.request, f.run);
    assert.equal(report.ready, true);
    assert.deepEqual(f.calls, [["status", "--json"]]);
    executeLeaseRetirement(f.s, f.request, report.reportId, f.run);
    assert.deepEqual(f.calls.at(-1), [
      "return",
      f.cwd,
      "--if-lease-id",
      "exact-lease",
      "--if-lease-holder",
      "exact-holder",
    ]);
    assert.ok(f.s.setting("retired-lease:conversation:worker"));
  } finally {
    f.close();
  }
});
test("dirty or unlanded work, changed leases, live processes, and stale reports never return", () => {
  const f = fixture();
  try {
    const report = prepareLeaseRetirement(f.s, f.request, f.run);
    fs.writeFileSync(path.join(f.cwd, "untracked.md"), "Do not discard");
    assert.throws(
      () => executeLeaseRetirement(f.s, f.request, report.reportId, f.run),
      /blocked or stale/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.cwd, "untracked.md"), "utf8"),
      "Do not discard",
    );
    f.git("add", "untracked.md");
    f.git("commit", "-m", "Unlanded work");
    assert.equal(prepareLeaseRetirement(f.s, f.request, f.run).ready, false);
    f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    assert.throws(
      () => executeLeaseRetirement(f.s, f.request, report.reportId, f.run),
      /blocked or stale/,
    );
    f.pool[0].lease_id = "replacement";
    assert.equal(prepareLeaseRetirement(f.s, f.request, f.run).ready, false);
    f.pool[0].lease_id = "exact-lease";
    f.pool[0].processes = [{ pid: process.pid }];
    assert.equal(prepareLeaseRetirement(f.s, f.request, f.run).ready, false);
    assert.equal(
      f.calls.some((args) => args[0] === "return"),
      false,
    );
  } finally {
    f.close();
  }
});
test("declaring ordinary worker work scratch cannot bypass preservation", () => {
  const f = fixture();
  try {
    const artifactId = f.s.artifact(
      undefined,
      "report.md",
      "Evidence",
      "text/markdown",
      "worker",
    );
    const report = prepareLeaseRetirement(
      f.s,
      {
        kind: "conversation",
        targetId: "worker",
        scratch: { artifactId, reason: "Finished" },
      },
      f.run,
    );
    assert.equal(report.ready, false);
    assert.match(report.blockers.join(" "), /unchanged source revision/);
  } finally {
    f.close();
  }
});
test("scratch check retirement preserves verified evidence and refuses corrupt artifacts", () => {
  const f = fixture();
  try {
    const artifactId = f.s.artifact(
      undefined,
      "validation.json",
      '{"passed":true}',
      "application/json",
    );
    const lease = f.s.setting("lease:worker");
    const job = {
      id: "check",
      cwd: f.cwd,
      lease,
      state: "passed",
      artifactId,
      revisionFacts: { head: f.git("rev-parse", "HEAD") },
    };
    f.s.setting("check:check", job);
    const dir = path.join(f.s.home, "app", "checks", "check");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "identity.json"),
      JSON.stringify({
        pid: process.pid,
        startIdentity: "different-start-identity",
      }),
    );
    const request: RetirementRequest = {
      kind: "check",
      targetId: "check",
      scratch: { artifactId, reason: "Check evidence is retained in the app" },
    };
    const report = prepareLeaseRetirement(f.s, request, f.run);
    assert.equal(report.ready, true);
    fs.writeFileSync(
      path.join(f.s.home, "app", "objects", artifactId),
      "corrupt",
    );
    assert.throws(
      () => executeLeaseRetirement(f.s, request, report.reportId, f.run),
      /blocked or stale/,
    );
    assert.equal(
      f.calls.some((args) => args[0] === "return"),
      false,
    );
  } finally {
    f.close();
  }
});
test("ignored local files and enabled dispatch block retirement", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.cwd, ".git", "info", "exclude"), "cache\n");
    fs.writeFileSync(path.join(f.cwd, "cache"), "valuable ignored output");
    assert.match(
      prepareLeaseRetirement(f.s, f.request, f.run).blockers.join(" "),
      /ignored changes/,
    );
    fs.unlinkSync(path.join(f.cwd, "cache"));
    f.s.setting("policy", { ...f.s.setting("policy"), paused: false });
    assert.match(
      prepareLeaseRetirement(f.s, f.request, f.run).blockers.join(" "),
      /Pause automatic dispatch/,
    );
  } finally {
    f.close();
  }
});
test("malformed runner provenance and provider sessions without a runner block retirement", () => {
  const f = fixture();
  try {
    const c = f.s.conversation("worker", { kind: "user", id: "test" });
    c.providerId = "retained-native-session";
    f.s.putConversation(c);
    assert.match(
      prepareLeaseRetirement(f.s, f.request, f.run).blockers.join(" "),
      /no runner provenance/,
    );
    c.runnerId = "runner";
    f.s.putConversation(c);
    const dir = path.join(f.s.home, "app", "runners", "runner");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "identity.json"), "{}");
    assert.match(
      prepareLeaseRetirement(f.s, f.request, f.run).blockers.join(" "),
      /identity is malformed/,
    );
  } finally {
    f.close();
  }
});
test("an ambiguous return durably blocks further conversation input", () => {
  const f = fixture();
  try {
    const report = prepareLeaseRetirement(f.s, f.request, f.run);
    const fail: LeaseCommand = (args, cwd) => {
      if (args[0] === "return") throw new Error("CLI response lost");
      return f.run(args, cwd);
    };
    assert.throws(
      () => executeLeaseRetirement(f.s, f.request, report.reportId, fail),
      /response lost/,
    );
    assert.ok(f.s.setting("lease-retirement-intent:conversation:worker"));
    assert.throws(() => f.s.assertLeaseActive("worker"), /lease retirement/);
  } finally {
    f.close();
  }
});
