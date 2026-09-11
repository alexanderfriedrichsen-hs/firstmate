import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { importLegacy, snapshotLegacy } from "../src/server/migration.ts";
import { Runtime } from "../src/server/runtime.ts";
import { randomUUID } from "node:crypto";
import { observeLegacy } from "../src/server/legacy-observer.ts";

for (const adopted of [false, true])
  test(
    "external status changes preserve evidence and wake observation-only for retained and adopted work: " +
      adopted,
    () => {
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
        const managed = s
          .tickets(user)
          .find((t) => t.brief.includes("managed-task"))!;
        if (adopted)
          s.setting("legacy:" + managed.id, {
            ...s.setting("legacy:" + managed.id),
            management: "app",
          });
        const t = s
          .tickets(user)
          .find((t) => t.brief.includes("private-task"))!;
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
        assert.equal(JSON.parse(wakes[0].data).observationOnly, true);
        assert.equal(JSON.parse(wakes[0].data).observation, "Report ready");
        const c: any = {
          id: randomUUID(),
          provider: "codex",
          model: "test",
          role: "supervisor",
          cwd: s.home,
          incarnation: 0,
          state: "idle",
          inputOwner: "automation",
          version: 1,
        };
        s.putConversation(c);
        s.setting("policy", { ...s.setting("policy"), paused: false });
        new Runtime(s).scheduleWakes();
        assert.equal(
          (s.db.prepare("SELECT count(*) n FROM outbox").get() as any).n,
          1,
        );
        assert.equal(s.externallyManaged(managed.id), !adopted);
        assert.doesNotMatch(JSON.stringify(wakes), /PRIVATE|private-task/);
        assert.equal(
          (s.db.prepare("SELECT count(*) n FROM artifacts").get() as any).n,
          1,
        );
        assert.equal(s.ticket(t.id, user).handling, "human_only");
        assert.equal(
          s.setting("legacyExternalChanges").requiresReconciliation,
          false,
        );
      } finally {
        s.db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
test("a changed privacy section suppresses status publication until reconciliation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-observer-private-"));
  const source = path.join(root, "legacy");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  fs.mkdirSync(path.join(source, "state"));
  fs.writeFileSync(
    path.join(source, "data", "backlog.md"),
    "## Queued\n- [ ] moved-task - Work\n",
  );
  const s = new Store(homePath(path.join(root, "app")));
  s.fence();
  try {
    importLegacy(s, source);
    s.setting("shadowMode", false);
    const checkpoint = snapshotLegacy(source);
    s.setting("legacyCheckpoint", checkpoint);
    fs.writeFileSync(
      path.join(source, "data", "backlog.md"),
      "## Human only\n- [ ] moved-task - Private work\n",
    );
    fs.writeFileSync(
      path.join(source, "state", "moved-task.status"),
      "PRIVATE_STATUS_SENTINEL",
    );
    observeLegacy(s);
    observeLegacy(s);
    assert.equal(
      (s.db.prepare("SELECT count(*) n FROM artifacts").get() as any).n,
      0,
    );
    assert.equal(
      (s.db.prepare("SELECT count(*) n FROM wakes").get() as any).n,
      0,
    );
    const supervisor = { kind: "supervisor" as const, id: "firstmate" };
    assert.doesNotMatch(
      JSON.stringify(
        s.tickets(supervisor).map((t) => s.detail(t.id, supervisor)),
      ),
      /PRIVATE_STATUS_SENTINEL/,
    );
    assert.equal(
      s.setting("legacyCheckpoint").fingerprint,
      checkpoint.fingerprint,
    );
  } finally {
    s.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
