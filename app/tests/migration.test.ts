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
  next.db.close();
  s.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
