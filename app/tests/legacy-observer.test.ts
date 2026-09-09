import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { importLegacy, snapshotLegacy } from "../src/server/migration.ts";
import { observeLegacy } from "../src/server/legacy-observer.ts";

test("external status changes create one managed wake without exposing Human only work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-observer-"));
  const source = path.join(root, "legacy");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  fs.mkdirSync(path.join(source, "state"));
  fs.writeFileSync(
    path.join(source, "data/backlog.md"),
    "## Queued\n- [ ] managed-task - Managed\n- [ ] private-task - Private\n",
  );
  const s = new Store(homePath(path.join(root, "app")));
  s.fence();
  try {
    importLegacy(s, source);
    s.setting("shadowMode", false);
    s.setting("legacyCheckpoint", snapshotLegacy(source));
    const user = { kind: "user" as const, id: "fixture" };
    const t = s.tickets(user).find((t) => t.brief.includes("private-task"))!;
    t.handling = "human_only";
    s.putTicket(t);
    fs.writeFileSync(
      path.join(source, "state/managed-task.status"),
      "Report ready",
    );
    fs.writeFileSync(
      path.join(source, "state/private-task.status"),
      "PRIVATE_STATUS_SENTINEL",
    );
    observeLegacy(s);
    observeLegacy(s);
    const wakes = s.db.prepare("SELECT * FROM wakes").all() as any[];
    assert.equal(wakes.length, 1);
    assert.doesNotMatch(JSON.stringify(wakes), /PRIVATE|private-task/);
    assert.equal(
      (s.db.prepare("SELECT count(*) n FROM artifacts").get() as any).n,
      1,
    );
    assert.equal(s.ticket(t.id, user).handling, "human_only");
    assert.equal(
      s.setting("legacyExternalChanges").requiresReconciliation,
      true,
    );
  } finally {
    s.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
