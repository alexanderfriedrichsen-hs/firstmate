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
    for (const route of [
      "providers",
      "catalog?topic=account",
      "catalog?topic=skills",
      "catalog?topic=models",
      "context",
      "library",
      "skill?path=/tmp/private.md",
    ]) {
      assert.equal(
        (
          await fetch(base + "/v1/" + route, {
            headers: { Authorization: "Bearer scoped-test-token" },
          })
        ).status,
        404,
        route + " must be operator-only",
      );
    }
    assert.equal(
      (
        await fetch(base + "/v1/providers/claude/login", {
          method: "POST",
          headers: { Authorization: "Bearer scoped-test-token" },
          body: "{}",
        })
      ).status,
      404,
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
    const ticketFor = (handling: string) =>
      store.command(
        { kind: "user", id: "fixture" },
        {
          commandId: randomUUID(),
          type: "ticket.create",
          payload: { title: "Wake boundary fixture", handling },
        },
      ).ticket;
    const own = ticketFor("agent_managed");
    const other = ticketFor("agent_managed");
    const hidden = ticketFor("human_only");
    store.db.prepare("DELETE FROM wakes").run();
    for (const [id, ticketId, state] of [
      ["global-pending", null, "pending"],
      ["global-presented", null, "presented"],
      ["own-pending", own.id, "pending"],
      ["own-presented", own.id, "presented"],
      ["other-presented", other.id, "presented"],
      ["private-presented", hidden.id, "presented"],
      ["handled", own.id, "handled"],
      ["cancelled", own.id, "cancelled"],
    ])
      store.db
        .prepare("INSERT INTO wakes VALUES(?,?,?,?,?)")
        .run(
          id,
          ticketId,
          state,
          JSON.stringify({ kind: "fixture" }),
          new Date().toISOString(),
        );
    store.setting("agentTokens", [
      { token: "scoped-test-token", actor: agent },
      {
        token: "worker-test-token",
        actor: { kind: "worker", id: "worker", ticketId: own.id },
      },
      {
        token: "unscoped-worker-token",
        actor: { kind: "worker", id: "worker-no-ticket" },
      },
    ]);
    const wakeIds = async (headers: Record<string, string>) =>
      (
        await fetch(base + "/v1/wakes", { headers }).then((response) =>
          response.json(),
        )
      )
        .map((wake: any) => wake.id)
        .sort();
    assert.deepEqual(
      await wakeIds({ cookie }),
      [
        "global-pending",
        "global-presented",
        "other-presented",
        "own-pending",
        "own-presented",
        "private-presented",
      ].sort(),
    );
    assert.deepEqual(
      await wakeIds({ Authorization: "Bearer scoped-test-token" }),
      [
        "global-pending",
        "global-presented",
        "other-presented",
        "own-pending",
        "own-presented",
      ].sort(),
    );
    assert.deepEqual(
      await wakeIds({ Authorization: "Bearer worker-test-token" }),
      ["own-pending", "own-presented"],
    );
    assert.deepEqual(
      await wakeIds({ Authorization: "Bearer unscoped-worker-token" }),
      [],
    );
    store.putTicket({ ...own, handling: "human_only" });
    assert.deepEqual(
      await wakeIds({ Authorization: "Bearer worker-test-token" }),
      [],
    );
  } finally {
    web.close();
    store.db.close();
  }
});
