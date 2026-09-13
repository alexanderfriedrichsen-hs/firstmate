import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { Store } from "../src/server/store.ts";
import { homePath } from "../src/server/home.ts";
import { serve } from "../src/server/http.ts";

test(
  "operator can recover an unstarted worker without an active Firstmate and preserve queued input",
  { timeout: 30000 },
  async () => {
    const home = homePath(
      fs.mkdtempSync(path.join(os.tmpdir(), "fm-recover-browser-")),
    );
    const store = new Store(home);
    store.fence();
    store.setting("project", {
      source: home,
      remote: "test",
      requiredChecks: [],
    });
    store.setting("providerModelCatalog.codex", [{ model: "test" }]);
    const user = { kind: "user" as const, id: "test" };
    const command = (type: string, payload: any = {}, target?: any) =>
      store.command(user, {
        commandId: randomUUID(),
        type,
        payload,
        targetId: target?.id,
        expectedVersion: target?.version,
      });
    const ticket = command("ticket.create", {
      title: "Recover this worker",
    }).ticket;
    const worker = command("conversation.create", {
      role: "worker",
      ticketId: ticket.id,
      provider: "codex",
      model: "test",
    }).conversation;
    store.db
      .prepare(
        "UPDATE outbox SET state='uncertain' WHERE kind='conversation.launch'",
      )
      .run();
    command("conversation.send", { text: "Preserved pending brief" }, worker);
    const socket = net.createServer();
    await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((r) => socket.close(() => r()));
    const web = serve(store, port);
    await web.start();
    const browser = await chromium.launch({
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/#ticket/${ticket.id}`);
      await page
        .getByRole("button", {
          name: "Open worker conversation ↗",
          exact: true,
        })
        .click();
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/v1/commands") &&
          r.request().postDataJSON().type === "conversation.reconcileLaunch",
      );
      await page
        .getByRole("button", { name: "Recover launch", exact: true })
        .click();
      const accepted = await response;
      assert.equal(accepted.status(), 202);
      assert.equal(
        accepted.request().postDataJSON().expectedVersion,
        store.conversation(worker.id, user).version - 1,
      );
      assert.equal(
        (
          store.db
            .prepare(
              "SELECT count(*) n FROM outbox WHERE kind='conversation.reconcileLaunch' AND state='pending'",
            )
            .get() as any
        ).n,
        1,
      );
      assert.equal(
        (
          store.db
            .prepare(
              "SELECT count(*) n FROM outbox WHERE kind='conversation.send' AND state='pending'",
            )
            .get() as any
        ).n,
        1,
      );
      assert.equal(
        store.messages(worker.id)[0].content,
        "Preserved pending brief",
      );
    } finally {
      await browser.close();
      web.close();
      store.db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
