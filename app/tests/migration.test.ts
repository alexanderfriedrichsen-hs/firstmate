import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import {
  importLegacy,
  prepareCutover,
  executeCutover,
  rollbackExport,
  recoverCutover,
  abortCutover,
  prepareRollback,
  executeRollback,
} from "../src/server/migration.ts";
test("disposable cutover rechecks source, transfers IDs once, and preserves a private rollback export", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-cutover-"));
  const source = path.join(root, "legacy");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "data", "backlog.md"),
    "## Queued\n- [ ] original-task - Keep this record\n",
  );
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  fs.cpSync(path.join(repository, "bin"), path.join(source, "bin"), {
    recursive: true,
  });
  const s = new Store(homePath(path.join(root, "staging")));
  s.fence();
  importLegacy(s, source);
  assert.equal(
    (
      s.db
        .prepare("SELECT COUNT(*) AS n FROM wakes WHERE state='pending'")
        .get() as any
    ).n,
    0,
  );
  const id = s.tickets({ kind: "user", id: "test" })[0].id;
  const user = { kind: "user" as const, id: "test" };
  s.command(user, {
    commandId: randomUUID(),
    type: "ticket.create",
    payload: { title: "PRIVATE_ROLLBACK_SENTINEL", handling: "human_only" },
  });
  let report = prepareCutover(s, source, repository);
  assert.equal(report.ready, true);
  await assert.rejects(
    () => executeCutover(s, report, "wrong"),
    /explicit approval/,
  );
  assert.equal(fs.existsSync(path.join(source, "app", "control-mode")), false);
  fs.appendFileSync(
    path.join(source, "data", "backlog.md"),
    "  New legacy note\n",
  );
  await assert.rejects(() => executeCutover(s, report, report.id), /changed/);
  report = prepareCutover(s, source, repository);
  const receipt = await executeCutover(s, report, report.id);
  assert.equal(receipt.complete, true);
  assert.equal(s.setting("transferDestination"), fs.realpathSync(source));
  assert.equal(prepareCutover(s, source, repository).ready, false);
  const next = new Store(source);
  next.fence();
  assert.equal(next.ticket(id, user).id, id);
  assert.equal(next.setting("shadowMode"), false);
  assert.equal(next.setting("transferDestination"), null);
  assert.match(next.ticket(id, user).brief, /New legacy note/);
  next.command(user, {
    commandId: randomUUID(),
    type: "ticket.update",
    targetId: id,
    expectedVersion: next.ticket(id, user).version,
    payload: { title: "New app work after transfer" },
  });
  const destination = path.join(root, "rollback");
  await rollbackExport(next, destination);
  assert.match(
    fs.readFileSync(path.join(destination, "managed.json"), "utf8"),
    /New app work after transfer/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(destination, "backlog.md"), "utf8"),
    /PRIVATE_ROLLBACK_SENTINEL/,
  );
  assert.match(
    fs.readFileSync(path.join(destination, "human-only.json"), "utf8"),
    /PRIVATE_ROLLBACK_SENTINEL/,
  );
  const alias = path.join(root, "export-alias");
  fs.symlinkSync(source, alias);
  assert.throws(
    () => prepareRollback(next, path.join(alias, "inside")),
    /outside and not overlap/,
  );
  assert.throws(() => prepareRollback(next, destination), /absent or empty/);
  const releaseReport = prepareRollback(
    next,
    path.join(root, "release-export"),
  );
  await assert.rejects(
    () => executeRollback(next, releaseReport, "wrong"),
    /explicit approval/,
  );
  const originalSetting = next.setting.bind(next);
  next.setting = (key: string, value?: unknown) => {
    const result = originalSetting(key, value);
    if (key === "ownershipReleased" && value !== undefined)
      throw new Error("crash after release intent");
    return result;
  };
  await assert.rejects(
    () => executeRollback(next, releaseReport, releaseReport.id),
    /crash after release intent/,
  );
  next.setting = originalSetting;
  assert.equal(
    fs.existsSync(path.join(source, "app", "rollback-receipt.json")),
    false,
  );
  const released = await executeRollback(next, releaseReport, releaseReport.id);
  assert.equal(released.ownershipTransferred, true);
  assert.equal(fs.existsSync(path.join(source, "app", "control-mode")), false);
  assert.equal(next.setting("ownershipReleased").reportId, releaseReport.id);
  assert.equal(
    (await executeRollback(next, releaseReport, releaseReport.id)).reportId,
    releaseReport.id,
  );
  assert.match(
    fs.readFileSync(path.join(source, "data", "backlog.md"), "utf8"),
    /original-task/,
  );
  assert.equal(prepareCutover(s, source, repository).ready, false);
  next.db.close();
  s.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("interrupted image publication recovers only unchanged bytes and the approved report", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-recover-"));
  const source = path.join(root, "legacy");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "data", "backlog.md"),
    "## Queued\n- [ ] recovery-task - Keep identity\n",
  );
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  fs.cpSync(path.join(repository, "bin"), path.join(source, "bin"), {
    recursive: true,
  });
  const store = new Store(homePath(path.join(root, "staging")));
  store.fence();
  importLegacy(store, source);
  const report = prepareCutover(store, source, repository);
  const outside = path.join(root, "outside-app");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(source, "app"));
  await assert.rejects(
    () => executeCutover(store, report, report.id),
    /symbolic links/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(source, "app"));
  const originalBackup = store.backup.bind(store);
  store.backup = async () => {
    throw new Error("simulated crash before image publication");
  };
  await assert.rejects(
    () => executeCutover(store, report, report.id),
    /simulated crash/,
  );
  assert.equal(store.setting("shadowMode"), true);
  assert.equal(prepareCutover(store, source, repository).ready, false);
  assert.equal(fs.existsSync(path.join(source, "app", "control-mode")), true);
  assert.equal(fs.existsSync(path.join(source, "app", "state.sqlite")), false);
  await assert.rejects(
    () => executeCutover(store, report, report.id),
    /Incomplete transfer/,
  );
  store.backup = originalBackup;
  const receipt = await recoverCutover(store, report, report.id);
  assert.equal(receipt.complete, true);
  assert.equal(
    (await executeCutover(store, report, report.id)).reportId,
    receipt.reportId,
  );
  // Crash after database publication but before receipt publication.
  fs.unlinkSync(path.join(source, "app", "cutover-receipt.json"));
  const target = path.join(source, "app", "state.sqlite");
  const image = fs.readFileSync(target);
  fs.appendFileSync(target, "changed");
  await assert.rejects(
    () => recoverCutover(store, report, report.id),
    /Target database changed/,
  );
  fs.writeFileSync(target, image);
  assert.equal((await recoverCutover(store, report, report.id)).complete, true);
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("rollback rejects live or ambiguous runner identities", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-rollback-guard-"));
  const store = new Store(homePath(root));
  store.fence();
  const runner = path.join(root, "app", "runners", "test");
  fs.mkdirSync(runner, { recursive: true });
  assert.throws(() => prepareRollback(store, root + "-export"), /ambiguous/);
  fs.writeFileSync(
    path.join(runner, "identity.json"),
    JSON.stringify({ pid: process.pid }),
  );
  assert.throws(
    () => prepareRollback(store, root + "-export"),
    /stop all app runners/,
  );
  fs.rmSync(path.join(root, "app", "runners"), { recursive: true });
  store.putConversation({
    id: randomUUID(),
    provider: "codex",
    providerId: "retained-native",
    model: "fixture",
    role: "worker",
    cwd: root,
    incarnation: 1,
    state: "idle",
    inputOwner: "user",
    version: 1,
  });
  assert.throws(
    () => prepareRollback(store, root + "-export"),
    /identity is missing or ambiguous/,
  );
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("abort releases an interrupted transfer while preserving new legacy work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-abort-"));
  const source = path.join(root, "legacy");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "data", "backlog.md"),
    "## Queued\n- [ ] abort-task - Original\n",
  );
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  fs.cpSync(path.join(repository, "bin"), path.join(source, "bin"), {
    recursive: true,
  });
  const store = new Store(homePath(path.join(root, "staging")));
  store.fence();
  importLegacy(store, source);
  const report = prepareCutover(store, source, repository);
  store.backup = async () => {
    throw new Error("interrupted");
  };
  await assert.rejects(
    () => executeCutover(store, report, report.id),
    /interrupted/,
  );
  const script = path.join(source, "bin", "fm-app-fence-lib.sh");
  const original = fs.readFileSync(script);
  fs.appendFileSync(script, "# changed\n");
  await assert.rejects(
    () => recoverCutover(store, report, report.id),
    /Ownership or source changed/,
  );
  fs.writeFileSync(script, original);
  fs.appendFileSync(
    path.join(source, "data", "backlog.md"),
    "- [ ] new-work - Retained worker update\n",
  );
  await assert.rejects(
    () => recoverCutover(store, report, report.id),
    /Legacy state changed/,
  );
  await assert.rejects(
    () => abortCutover(store, report, "wrong"),
    /explicit approval/,
  );
  assert.equal((await abortCutover(store, report, report.id)).aborted, true);
  assert.equal((await abortCutover(store, report, report.id)).aborted, true);
  assert.equal(fs.existsSync(path.join(source, "app", "control-mode")), false);
  assert.match(
    fs.readFileSync(path.join(source, "data", "backlog.md"), "utf8"),
    /Retained worker update/,
  );
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("legacy private moves conceal mapped tickets and cancellation does not queue work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-private-import-"));
  const source = path.join(root, "legacy");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  const file = path.join(source, "data", "backlog.md");
  fs.writeFileSync(file, "## In flight\n- [ ] private-task - Keep identity\n");
  const store = new Store(homePath(path.join(root, "staging")));
  store.fence();
  importLegacy(store, source);
  const user = { kind: "user" as const, id: "test" };
  const ticket = store.tickets(user)[0];
  assert.equal(ticket.status, "active");
  fs.writeFileSync(
    file,
    "## Human only\n- [ ] private-task - Keep identity\n## Cancelled\n- [ ] cancelled-task - No dispatch\n",
  );
  importLegacy(store, source);
  assert.equal(store.ticket(ticket.id, user).handling, "human_only");
  assert.throws(
    () => store.ticket(ticket.id, { kind: "supervisor", id: "test" }),
    /not found/,
  );
  assert.equal(
    store.tickets(user).find((t) => t.id !== ticket.id)?.status,
    "cancelled",
  );
  assert.equal(
    (
      store.db
        .prepare("SELECT COUNT(*) AS n FROM wakes WHERE state='pending'")
        .get() as any
    ).n,
    0,
  );
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("reimport normalizes untouched old imported state and preflight reports conflicts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-old-import-"));
  const source = path.join(root, "legacy");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "data", "backlog.md"),
    "## In flight\n- [ ] old-task - Imported by an older release\n",
  );
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  fs.cpSync(path.join(repository, "bin"), path.join(source, "bin"), {
    recursive: true,
  });
  const store = new Store(homePath(path.join(root, "staging")));
  store.fence();
  importLegacy(store, source);
  const actor = { kind: "user" as const, id: "test" };
  const old = store.tickets(actor)[0];
  old.status = "backlog";
  store.putTicket(old);
  importLegacy(store, source);
  assert.equal(store.ticket(old.id, actor).status, "active");
  assert.equal(store.tickets(actor).length, 1);
  const manual = store.ticket(old.id, actor);
  manual.status = "cancelled";
  manual.version++;
  store.putTicket(manual);
  importLegacy(store, source);
  assert.equal(store.ticket(old.id, actor).status, "cancelled");
  store.setting("migration-conflict:" + old.id, {
    reason: "Unresolved legacy update",
  });
  const report = prepareCutover(store, source, repository);
  assert.equal(report.ready, false);
  assert.equal(report.migrationConflicts.length, 1);
  assert.equal(fs.existsSync(path.join(source, "app", "control-mode")), false);
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("overlapping source and staging trees never approve cutover", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-overlap-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(
    path.join(root, "data", "backlog.md"),
    "## Queued\n- [ ] overlap-task - Keep state\n",
  );
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  fs.cpSync(path.join(repository, "bin"), path.join(root, "bin"), {
    recursive: true,
  });
  const store = new Store(homePath(path.join(root, "data", "staging")));
  store.fence();
  const report = prepareCutover(store, root, repository);
  assert.equal(report.overlappingHomes, true);
  assert.equal(report.ready, false);
  await assert.rejects(
    () => executeCutover(store, report, report.id),
    /explicit approval/,
  );
  assert.equal(fs.existsSync(path.join(root, "app", "control-mode")), false);
  assert.equal(
    fs.existsSync(path.join(store.home, "app", "migration-backups")),
    false,
  );
  store.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
