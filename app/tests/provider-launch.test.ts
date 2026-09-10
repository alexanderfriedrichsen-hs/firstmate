import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import {
  ProviderAuth,
  providerExecutable,
} from "../src/server/provider-auth.ts";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { Runtime } from "../src/server/runtime.ts";

test("Cursor authenticated as cursor-agent launches the same executable without zsh", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-cursor-launch-"));
  const store = new Store(homePath(home));
  store.fence();
  const bin = path.join(home, "bin with spaces");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "cursor-agent");
  fs.writeFileSync(
    executable,
    "#!/bin/sh\nprintf '{\"isAuthenticated\":true}\\n'\n",
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  const exec = childProcess.execFileSync;
  const auth = new ProviderAuth();
  try {
    process.env.PATH = bin;
    t.mock.method(os, "homedir", () => home);
    assert.equal((await auth.status("cursor")).authenticated, true);
    t.mock.method(childProcess, "execFileSync", ((
      file: string,
      ...args: any[]
    ) => {
      if (file === "/bin/zsh")
        throw Object.assign(new Error("spawnSync /bin/zsh ENOENT"), {
          code: "ENOENT",
        });
      return (exec as any)(file, ...args);
    }) as any);
    const launches: any[] = [];
    t.mock.method(childProcess, "spawn", ((...args: any[]) => {
      launches.push(args);
      return { unref() {} };
    }) as any);
    syncBuiltinESMExports();
    store.setting("policy", {
      ...store.setting("policy"),
      cursor: { enabled: true, mode: "subscription_usage" },
    });
    store.setting("providerModelCatalog.cursor", [{ model: "test-model" }]);
    const conversation = store.command(
      { kind: "user", id: "test" },
      {
        commandId: randomUUID(),
        type: "conversation.create",
        payload: {
          provider: "cursor",
          model: "test-model",
          role: "supervisor",
        },
      },
    ).conversation;
    await new Runtime(store).launch(conversation);
    assert.equal(launches.length, 1);
    assert.equal(launches[0][0], process.execPath);
    const config = JSON.parse(fs.readFileSync(launches[0][1].at(-1), "utf8"));
    assert.equal(config.executable, executable);
    fs.unlinkSync(executable);
    const before = JSON.stringify(conversation);
    const tokenCount = store.setting("agentTokens").length;
    await assert.rejects(
      new Runtime(store).launch(conversation),
      /Install Cursor CLI/,
    );
    assert.equal(JSON.stringify(conversation), before);
    assert.equal(store.setting("agentTokens").length, tokenCount);
    assert.equal(launches.length, 1);
    fs.rmSync(path.dirname(config.socket), { recursive: true, force: true });
  } finally {
    auth.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    store.db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("provider executable selection preserves aliases, PATH order, and local-bin fallback", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-provider-path-"));
  const bin = path.join(home, "bin");
  const localBin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(localBin, { recursive: true });
  const previousPath = process.env.PATH;
  const executable = (dir: string, name: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o700 });
    return file;
  };
  try {
    process.env.PATH = bin;
    t.mock.method(os, "homedir", () => home);
    const agent = executable(bin, "agent");
    assert.equal(providerExecutable("cursor"), agent);
    const cursor = executable(localBin, "cursor-agent");
    assert.equal(providerExecutable("cursor"), cursor);
    fs.chmodSync(cursor, 0o600);
    assert.equal(providerExecutable("cursor"), agent);
    assert.equal(providerExecutable("claude"), undefined);
    const claude = executable(localBin, "claude");
    assert.equal(providerExecutable("claude"), claude);
    const codex = executable(bin, "codex");
    executable(localBin, "codex");
    assert.equal(providerExecutable("codex"), codex);
  } finally {
    t.mock.restoreAll();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
