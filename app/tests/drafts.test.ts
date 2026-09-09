import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { assertDraftCurrent } from "../src/server/drafts.ts";

test("publication rechecks lifecycle, revision, and writer ownership after remote reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-draft-"));
  const s = new Store(homePath(root));
  s.fence();
  try {
    const { ticket: t } = s.command(
      { kind: "user", id: "fixture" },
      {
        commandId: randomUUID(),
        type: "ticket.create",
        payload: { title: "Draft race" },
      },
    );
    t.revision = "original";
    s.putTicket(t);
    s.setting("writerReservation:" + t.id, { commandId: "publication" });
    assert.equal(
      assertDraftCurrent(s, t.id, "original", "publication").id,
      t.id,
    );
    for (const patch of [
      { handling: "human_only" },
      { status: "completed" },
      { revision: "new" },
    ]) {
      s.putTicket({ ...t, ...patch });
      assert.throws(
        () => assertDraftCurrent(s, t.id, "original", "publication"),
        /changed/,
      );
    }
    s.putTicket(t);
    s.setting("writerReservation:" + t.id, { commandId: "replacement" });
    assert.throws(
      () => assertDraftCurrent(s, t.id, "original", "publication"),
      /changed/,
    );
  } finally {
    s.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
