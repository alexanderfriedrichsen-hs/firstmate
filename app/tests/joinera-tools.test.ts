import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { joineraTool } from "../src/server/joinera-tools.ts";

test("Joinera tools resolve the current home and explicit executable overrides", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "firstmate-tools-"));
  try {
    const bin = path.join(home, ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const tool = path.join(bin, "joinera-draft-pr-adapter");
    fs.writeFileSync(tool, "#!/bin/sh\n", { mode: 0o700 });
    assert.equal(joineraTool("draft", {}, home), tool);
    assert.equal(
      joineraTool(
        "validation",
        { FIRSTMATE_JOINERA_VALIDATION_LAYER: tool },
        home,
      ),
      tool,
    );
    assert.throws(
      () =>
        joineraTool("draft", { FIRSTMATE_JOINERA_ADAPTER: "relative" }, home),
      /absolute executable path/,
    );
    fs.chmodSync(tool, 0o600);
    assert.throws(
      () => joineraTool("draft", {}, home),
      /FIRSTMATE_JOINERA_ADAPTER/,
    );
    assert.throws(
      () => joineraTool("validation", {}, home),
      /Install joinera-validation-layer/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
