import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ProviderAuth } from "../src/server/provider-auth.ts";
import { parseCursorModels } from "../src/server/catalog.ts";
function fakeLaunch(outputs: string[], calls: any[]) {
  return ((file: string, args: string[], options: any) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", null);
      return true;
    };
    calls.push({ file, args, options, child });
    if (!args.includes("login"))
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(outputs.shift() ?? "{}"));
        child.emit("close", 0);
      });
    return child;
  }) as any;
}
test("provider auth reports only normalized status and starts native subscription login", async () => {
  const calls: any[] = [];
  const auth = new ProviderAuth(
    () => "/test/claude",
    fakeLaunch(
      [
        '{"loggedIn":true,"accessToken":"SECRET"}',
        '{"loggedIn":true}',
        '{"loggedIn":true}',
        '{"loggedIn":true}',
      ],
      calls,
    ),
  );
  assert.equal(
    JSON.stringify(await auth.status("claude")).includes("SECRET"),
    false,
  );
  assert.equal((await auth.login("claude")).login.state, "pending");
  assert.deepEqual(calls.find((c) => c.args.includes("login")).args, [
    "auth",
    "login",
    "--claudeai",
  ]);
  await auth.login("claude");
  assert.equal(calls.filter((c) => c.args.includes("login")).length, 1);
  assert.equal((await auth.cancel("claude")).login.state, "cancelled");
  auth.close();
});
test("missing providers and unknown status are explicit", async () => {
  assert.equal(
    (await new ProviderAuth(() => undefined).login("cursor")).installed,
    false,
  );
  const auth = new ProviderAuth(
    () => "/test/agent",
    fakeLaunch(
      ['{"isAuthenticated":false,"hasRefreshToken":false}', "garbage"],
      [],
    ),
  );
  assert.equal((await auth.status("cursor")).authenticated, false);
  const unknown = new ProviderAuth(
    () => "/test/agent",
    fakeLaunch(["garbage"], []),
  );
  assert.equal((await unknown.status("cursor")).authenticated, null);
});
test("Cursor model parser accepts observed CLI format without inventing effort", () => {
  assert.deepEqual(
    parseCursorModels(
      "Available models\n\nsonnet - Claude Sonnet (current, default)\nTip: use --model",
    ),
    [
      {
        model: "sonnet",
        displayName: "Claude Sonnet",
        defaultReasoningEffort: "",
        supportedReasoningEfforts: [],
      },
    ],
  );
  assert.throws(() => parseCursorModels("Error: Authentication required"));
});
