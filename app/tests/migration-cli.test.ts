import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(repository, "app/src/server/cli.ts");
function run(home: string, ...args: string[]) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", cli, ...args, "--home", home, "--json"],
      {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, FM_AGENT_TOKEN_FILE: "" },
      },
    ).trim(),
  );
}
test("CLI installs a reviewed fence, transfers, recovers idempotently, and releases ownership", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-migration-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "legacy"),
    staging = path.join(root, "staging");
  fs.mkdirSync(path.join(target, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "data/backlog.md"),
    "## Queued\n- [ ] fixture-task - Preserve me\n",
  );
  const fence = run(staging, "fence-install", "--source", target);
  assert.equal(fence.ready, true);
  assert.equal(fs.existsSync(path.join(target, "app")), false);
  assert.equal(
    run(staging, "fence-install", "--approve-report", fence.id).complete,
    true,
  );
  const report = run(staging, "cutover", "--source", target);
  assert.equal(report.ready, true);
  assert.equal(
    run(staging, "cutover", "--approve-report", report.id).complete,
    true,
  );
  assert.equal(
    run(staging, "cutover", "--recover", "--approve-report", report.id)
      .complete,
    true,
  );
  const rollback = run(
    target,
    "rollback",
    "--release-ownership",
    "--output",
    path.join(root, "export"),
  );
  assert.equal(rollback.ready, true);
  assert.equal(
    run(
      target,
      "rollback",
      "--release-ownership",
      "--approve-report",
      rollback.id,
    ).ownershipTransferred,
    true,
  );
  assert.equal(fs.existsSync(path.join(target, "app/control-mode")), false);
  assert.equal(
    run(
      target,
      "rollback",
      "--release-ownership",
      "--approve-report",
      rollback.id,
    ).ownershipTransferred,
    true,
  );
  assert.equal(fs.existsSync(path.join(target, "app/control-mode")), false);
  assert.match(
    fs.readFileSync(path.join(target, "data/backlog.md"), "utf8"),
    /Preserve me/,
  );
  assert.equal(run(target, "status").policy.paused, true);
  const start = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "start", "--home", target, "--json"],
    { cwd: repository, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(start.status, 1);
  assert.match(start.stdout, /ownership was released/);
});
test("canonical live home requires app mode and limits released-history access", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-home-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, ".firstmate"),
    app = path.join(home, "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "state.sqlite"), "fixture");
  fs.writeFileSync(
    path.join(app, "cutover-receipt.json"),
    JSON.stringify({
      schema: "firstmate.ownership.v1",
      complete: true,
      source: fs.realpathSync(home),
      reportId: "transfer",
    }),
  );
  const probe = (options: unknown) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { homePath } from ${JSON.stringify(path.join(repository, "app/src/server/home.ts"))}; homePath(${JSON.stringify(home)}, ${JSON.stringify(options)});`,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, HOME: root },
      },
    );
  fs.writeFileSync(
    path.join(app, "control-mode"),
    JSON.stringify({ mode: "legacy", reportId: "transfer" }),
  );
  assert.equal(probe({ allowTransferred: true }).status, 1);
  fs.writeFileSync(
    path.join(app, "control-mode"),
    JSON.stringify({ mode: "app", reportId: "transfer" }),
  );
  assert.equal(probe({ allowTransferred: true }).status, 0);
  fs.rmSync(path.join(app, "control-mode"));
  fs.writeFileSync(
    path.join(app, "rollback-receipt.json"),
    JSON.stringify({
      schema: "firstmate.rollback.v1",
      reportId: "rollback",
      ownershipTransferred: true,
    }),
  );
  assert.equal(probe({ allowTransferred: true }).status, 1);
  assert.equal(
    probe({
      allowTransferred: true,
      allowReleasedRecovery: true,
      rollbackReportId: "wrong",
    }).status,
    1,
  );
  assert.equal(
    probe({
      allowTransferred: true,
      allowReleasedRecovery: true,
      rollbackReportId: "rollback",
    }).status,
    0,
  );
});
