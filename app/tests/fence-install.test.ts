import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  prepareFenceInstall,
  executeFenceInstall,
} from "../src/server/fence-install.ts";
import { ownHome } from "../src/server/home.ts";
function fixture(t: any, git = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  for (const home of [source, target]) {
    fs.mkdirSync(path.join(home, "bin/backends"), { recursive: true });
    fs.mkdirSync(path.join(home, "state"));
    fs.writeFileSync(
      path.join(home, "bin/run.sh"),
      home === source ? "#!/bin/sh\necho fenced\n" : "#!/bin/sh\necho old\n",
      { mode: 0o755 },
    );
  }
  if (git) {
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", target, ...args], { stdio: "ignore" });
    run("init");
    run("add", ".");
    run(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "fixture",
    );
  }
  return { source, target };
}
test("reviewed operational-home installation preserves originals and is idempotent", (t) => {
  const { source, target } = fixture(t);
  const report = prepareFenceInstall(target, source);
  assert.equal(report.ready, true);
  assert.match(report.targetVerification, /no Git baseline/);
  assert.throws(() => executeFenceInstall(report, "wrong"), /exact ready/);
  const receipt = executeFenceInstall(report, report.id);
  assert.equal(
    fs.readFileSync(path.join(target, "bin/run.sh"), "utf8"),
    fs.readFileSync(path.join(source, "bin/run.sh"), "utf8"),
  );
  assert.match(
    fs.readFileSync(path.join(receipt.backup, "originals/bin/run.sh"), "utf8"),
    /old/,
  );
  assert.deepEqual(executeFenceInstall(report, report.id), receipt);
  fs.writeFileSync(path.join(target, "bin/run.sh"), "operator edit");
  assert.throws(() => executeFenceInstall(report, report.id), /Target changed/);
});
test("dirty tracked targets and changes after approval are rejected", (t) => {
  const { source, target } = fixture(t, true);
  const report = prepareFenceInstall(target, source);
  assert.equal(report.ready, true);
  fs.writeFileSync(path.join(target, "bin/run.sh"), "operator edit");
  assert.equal(prepareFenceInstall(target, source).ready, false);
  assert.throws(() => executeFenceInstall(report, report.id), /changed/);
});
test("active legacy owners and shared home ownership block installation", (t) => {
  const { source, target } = fixture(t);
  fs.writeFileSync(path.join(target, "state/.lock"), String(process.pid));
  assert.equal(prepareFenceInstall(target, source).ready, false);
  fs.rmSync(path.join(target, "state/.lock"));
  const report = prepareFenceInstall(target, source);
  fs.mkdirSync(path.join(target, "app"));
  const release = ownHome(target);
  try {
    assert.throws(
      () => executeFenceInstall(report, report.id),
      /Another runtime/,
    );
  } finally {
    release();
  }
});
test("source drift and symlink substitutions block installation", (t) => {
  const { source, target } = fixture(t);
  const report = prepareFenceInstall(target, source);
  fs.writeFileSync(path.join(source, "bin/run.sh"), "new source");
  assert.throws(() => executeFenceInstall(report, report.id), /changed/);
  fs.rmSync(path.join(target, "bin/run.sh"));
  fs.symlinkSync(path.join(target, "absent"), path.join(target, "bin/run.sh"));
  assert.throws(() => prepareFenceInstall(target, source), /symlink/);
});
test("interrupted installation resumes from retained originals", (t) => {
  const { source, target } = fixture(t);
  fs.writeFileSync(path.join(source, "bin/second.sh"), "new second");
  fs.writeFileSync(path.join(target, "bin/second.sh"), "old second");
  const report = prepareFenceInstall(target, source);
  const receipt = executeFenceInstall(report, report.id);
  // Model a stop after the first replacement: one reviewed old file remains.
  fs.copyFileSync(
    path.join(receipt.backup, "originals/bin/second.sh"),
    path.join(target, "bin/second.sh"),
  );
  fs.rmSync(path.join(receipt.backup, "receipt.json"));
  assert.deepEqual(executeFenceInstall(report, report.id), receipt);
  assert.equal(
    fs.readFileSync(path.join(target, "bin/second.sh"), "utf8"),
    "new second",
  );
  assert.equal(
    fs.readFileSync(
      path.join(receipt.backup, "originals/bin/second.sh"),
      "utf8",
    ),
    "old second",
  );
});
test("recovery repairs a stop between file publication and executable mode restoration", (t) => {
  const { source, target } = fixture(t);
  const report = prepareFenceInstall(target, source);
  const receipt = executeFenceInstall(report, report.id);
  fs.chmodSync(path.join(target, "bin/run.sh"), 0o600);
  fs.rmSync(path.join(receipt.backup, "receipt.json"));
  executeFenceInstall(report, report.id);
  assert.equal(
    fs.statSync(path.join(target, "bin/run.sh")).mode & 0o777,
    0o755,
  );
});
test("common ownership refuses symlink lock files and app directories", (t) => {
  const { target } = fixture(t);
  const outside = path.join(target, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(target, "app"));
  assert.throws(() => ownHome(target), /symlink/);
  fs.rmSync(path.join(target, "app"));
  fs.mkdirSync(path.join(target, "app"));
  fs.writeFileSync(path.join(outside, "lock"), "");
  fs.symlinkSync(
    path.join(outside, "lock"),
    path.join(target, "app/owner.lock"),
  );
  assert.throws(() => ownHome(target), /ELOOP|symbolic/i);
});
test("watcher owner symlink is inspected only inside the expected state directory", (t) => {
  const { source, target } = fixture(t);
  const owner = path.join(target, "state/.watch.lock.owner.Fixture123");
  fs.mkdirSync(owner);
  fs.writeFileSync(path.join(owner, "pid"), String(process.pid));
  fs.symlinkSync(owner, path.join(target, "state/.watch.lock"));
  const report = prepareFenceInstall(target, source);
  assert.equal(report.ready, false);
  assert.ok(
    report.blockers.some((blocker) => blocker.includes(String(process.pid))),
  );
  fs.rmSync(path.join(target, "state/.watch.lock"));
  assert.equal(prepareFenceInstall(target, source).ready, true);
  const outside = path.join(source, "state/.watch.lock.owner.Outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "pid"), "99999999");
  fs.symlinkSync(outside, path.join(target, "state/.watch.lock"));
  const unsafe = prepareFenceInstall(target, source);
  assert.equal(unsafe.ready, false);
  assert.ok(unsafe.blockers.some((blocker) => blocker.includes("escapes")));
});
