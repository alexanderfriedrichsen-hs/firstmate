import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { homePath, ownHome, atomic } from "../src/server/home.ts";
test("legacy shared lock and app exclusive lock close the ownership-transfer race", async () => {
  const home = homePath(
    fs.mkdtempSync(path.join(os.tmpdir(), "fm-common-fence-")),
  );
  const helper = fileURLToPath(
    new URL("../../bin/fm-app-fence-lib.sh", import.meta.url),
  );
  const env = {
    ...process.env,
    FM_HOME: home,
    FM_APP_FENCE_LOCK_FILE: undefined,
  };
  const legacy = spawn(
    "bash",
    [
      "-c",
      '. "$1"; fm_app_require_legacy; echo READY; read -r hold',
      "_",
      helper,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    const output = await Promise.race([
      once(legacy.stdout, "data").then(([chunk]) => String(chunk)),
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(Error("Legacy guard did not become ready")),
          3000,
        ).unref(),
      ),
    ]);
    assert.match(output, /READY/);
    assert.throws(() => ownHome(home), /Another runtime/);
    legacy.kill("SIGTERM");
    await once(legacy, "exit");
    const release = ownHome(home);
    try {
      const denied = spawnSync(
        "bash",
        ["-c", '. "$1"; fm_app_require_legacy; echo MUTATION', "_", helper],
        { env, encoding: "utf8" },
      );
      assert.equal(denied.status, 3);
      assert.equal(denied.stdout.includes("MUTATION"), false);
      atomic(path.join(home, "app", "control-mode"), "app");
    } finally {
      release();
    }
    const stopped = spawnSync(
      "bash",
      ["-c", '. "$1"; fm_app_require_legacy; echo MUTATION', "_", helper],
      { env, encoding: "utf8" },
    );
    assert.equal(stopped.status, 3);
    assert.match(stopped.stderr, /controlled by the Firstmate app/);
  } finally {
    if (legacy.exitCode === null) legacy.kill("SIGTERM");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("nested Bash commands acquire the new home lock when a descriptor is inherited", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-cross-home-"));
  const helper = fileURLToPath(
    new URL("../../bin/fm-app-fence-lib.sh", import.meta.url),
  );
  try {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        '. "$1"; fm_app_require_legacy; FM_HOME="$2" /bin/bash -c \'. "$1"; fm_app_require_legacy; echo NESTED_OK\' _ "$1"',
        "_",
        helper,
        path.join(root, "second"),
      ],
      {
        env: { ...process.env, FM_HOME: path.join(root, "first") },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NESTED_OK/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
