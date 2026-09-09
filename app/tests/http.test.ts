import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { serve } from "../src/server/http.ts";
test("HTTP boundary separates operator and agent authorization and protects mutation origins", async () => {
  const tmp = net.createServer();
  await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
  const port = (tmp.address() as net.AddressInfo).port;
  await new Promise<void>((r) => tmp.close(() => r()));
  const store = new Store(
    homePath(fs.mkdtempSync(path.join(os.tmpdir(), "fm-http-"))),
  );
  store.fence();
  const agent = { kind: "supervisor", id: "agent" };
  store.setting("agentTokens", [{ token: "scoped-test-token", actor: agent }]);
  const web = serve(store, port);
  await web.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + "/v1/snapshot")).status, 401);
    assert.equal(
      (
        await fetch(base + "/v1/session", {
          headers: { Authorization: "Bearer scoped-test-token" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/v1/session", {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    const session = await fetch(base + "/v1/session");
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = await session.json();
    const input = {
      commandId: randomUUID(),
      type: "ticket.create",
      payload: { title: "PRIVATE_HTTP_SENTINEL", handling: "human_only" },
    };
    assert.equal(
      (
        await fetch(base + "/v1/commands", {
          method: "POST",
          headers: { cookie, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    const response = await fetch(base + "/v1/commands", {
      method: "POST",
      headers: {
        cookie,
        Origin: base,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    assert.equal(created.commandId, input.commandId);
    assert.equal(
      (
        await fetch(base + "/v1/tickets/" + created.ticketId, {
          headers: { Authorization: "Bearer scoped-test-token" },
        })
      ).status,
      404,
    );
    const snapshot = await fetch(base + "/v1/snapshot", {
      headers: { Authorization: "Bearer scoped-test-token" },
    }).then((r) => r.json());
    assert.deepEqual(snapshot.tickets, []);
    assert.equal(
      JSON.stringify(snapshot).includes("PRIVATE_HTTP_SENTINEL"),
      false,
    );
    assert.equal(
      (
        await fetch(base + created.statusUrl, {
          headers: { Authorization: "Bearer scoped-test-token" },
        })
      ).status,
      404,
    );
    const duplicate = await fetch(base + "/v1/commands", {
      method: "POST",
      headers: {
        cookie,
        Origin: base,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }).then((r) => r.json());
    assert.deepEqual(duplicate, created);
  } finally {
    web.close();
    store.db.close();
  }
});
