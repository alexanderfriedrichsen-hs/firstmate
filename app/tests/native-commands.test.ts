import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/server/store.ts";
import { Runtime } from "../src/server/runtime.ts";
import { homePath } from "../src/server/home.ts";
import { nativeCommands } from "../src/server/native-commands.ts";
test("native command catalogs reject malformed entries and replace only their conversation cache", () => {
  assert.deepEqual(
    nativeCommands(
      [
        null,
        {},
        "exit",
        "valid",
        "valid",
        { name: "bad command" },
        { name: "plugin:skill", description: {}, input: { hint: "file" } },
      ],
      ["exit"],
    ),
    [
      { name: "valid", description: "Provider command" },
      {
        name: "plugin:skill",
        description: "Provider command",
        argumentHint: "file",
      },
    ],
  );
  const home = homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-commands-")));
  const store = new Store(home);
  try {
    const runtime = new Runtime(store);
    const c: any = {
      id: "claude",
      provider: "claude",
      model: "sonnet",
      role: "supervisor",
      cwd: home,
      incarnation: 1,
      state: "idle",
      inputOwner: "user",
      version: 1,
    };
    store.putConversation(c);
    const apply = (payload: any) =>
      runtime.apply(c, {
        type: "claude.event",
        payload,
        at: new Date().toISOString(),
      });
    apply({
      type: "system",
      subtype: "init",
      slash_commands: ["exit", "test"],
      terminal_slash_commands: ["exit"],
    });
    assert.deepEqual(store.setting("native-commands:claude").commands, [
      { name: "test", description: "Provider command" },
    ]);
    apply({
      type: "system",
      subtype: "commands_changed",
      commands: [
        { name: "exit" },
        { name: "new", description: "Fresh", argumentHint: "target" },
      ],
    });
    assert.equal(
      store.setting("native-commands:claude").commands[0].name,
      "new",
    );
    const cursor = { ...c, id: "cursor", provider: "cursor" };
    store.putConversation(cursor);
    runtime.apply(cursor, {
      type: "cursor.update",
      payload: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review", input: { hint: "file" } },
        ],
      },
      at: new Date().toISOString(),
    });
    assert.equal(
      store.setting("native-commands:cursor").commands[0].argumentHint,
      "file",
    );
    assert.equal(
      store.setting("native-commands:claude").commands[0].name,
      "new",
    );
    apply({ type: "system", subtype: "commands_changed", commands: [] });
    assert.deepEqual(store.setting("native-commands:claude").commands, []);
  } finally {
    store.db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
