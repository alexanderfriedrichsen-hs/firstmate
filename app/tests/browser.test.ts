import { test } from "node:test";
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
  "browser preserves reading position, searches old history, and saves panel width",
  { timeout: 45000 },
  async () => {
    const chrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (!fs.existsSync(chrome))
      throw new Error(
        "Browser acceptance needs an installed Chrome executable",
      );
    const home = homePath(
      fs.mkdtempSync(path.join(os.tmpdir(), "fm-browser-")),
    );
    const store = new Store(home);
    store.fence();
    const cid = randomUUID();
    store.putConversation({
      id: cid,
      provider: "codex",
      model: "fixture",
      role: "supervisor",
      cwd: home,
      incarnation: 0,
      state: "idle",
      inputOwner: "automation",
      version: 1,
    });
    store.db.transaction(() => {
      for (let i = 0; i < 10000; i++)
        store.message(
          cid,
          randomUUID(),
          "assistant",
          i === 8
            ? "HISTORICAL_SEARCH_SENTINEL"
            : `Message ${i}. This durable fixture verifies stable transcript reading.\nSecond line.\nThird line.`,
          "message",
        );
    })();
    store.artifact(
      undefined,
      "sandbox.html",
      '<h1>Interactive artifact</h1><script>try { parent.document.body.dataset.escaped = "yes"; document.body.append("Unsafe"); } catch { document.body.append("Parent access blocked"); }</script>',
      "text/html",
      cid,
    );
    const socket = net.createServer();
    await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((r) => socket.close(() => r()));
    const web = serve(store, port);
    await web.start();
    const browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}`);
      await page
        .getByRole("heading", { name: "Firstmate", exact: true })
        .waitFor();
      await page.route("**/v1/catalog?topic=models&conversationId=*", (route) =>
        route.fulfill({
          json: {
            data: [
              {
                model: "fixture",
                displayName: "Fixture",
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  { reasoningEffort: "high", description: "More thinking" },
                  { reasoningEffort: "low", description: "Less thinking" },
                ],
              },
              {
                model: "small",
                displayName: "Small",
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Less thinking" },
                ],
              },
            ],
          },
        }),
      );
      await page.getByRole("button", { name: "Model", exact: true }).click();
      await page.getByLabel("Thinking effort").selectOption("high");
      await page.getByLabel("Firstmate model").selectOption("small");
      assert.equal(await page.getByLabel("Thinking effort").inputValue(), "");
      assert.equal(
        await page
          .getByLabel("Thinking effort")
          .locator('option[value="high"]')
          .count(),
        0,
      );
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page.getByLabel("New chat provider").selectOption("claude");
      await page.getByLabel("New chat model").selectOption("small");
      await page.getByLabel("New chat thinking effort").selectOption("low");
      assert.equal(
        await page
          .getByRole("button", { name: "Create new chat", exact: true })
          .isDisabled(),
        false,
      );
      let restartPayload: any;
      await page.route("**/v1/commands", (route) => {
        restartPayload = route.request().postDataJSON();
        return route.fulfill({ json: { ok: true } });
      });
      await page
        .getByRole("button", { name: "Create new chat", exact: true })
        .click();
      assert.equal(restartPayload.type, "conversation.restart");
      assert.deepEqual(restartPayload.payload, {
        provider: "claude",
        model: "small",
        effort: "low",
      });
      await page.unroute("**/v1/commands");
      await page.getByRole("button", { name: "New chat", exact: true }).click();
      await page.getByLabel("New chat provider").selectOption("cursor");
      assert.equal(
        await page.getByLabel("New chat thinking effort").inputValue(),
        "",
      );
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Pause automatic work", exact: true })
        .waitFor();
      await page.locator(".message").first().waitFor();
      assert.ok(
        (await page.locator(".message").count()) <= 100,
        "Initial history stays bounded",
      );
      const transcript = page.locator(".transcript");
      await transcript.click({ position: { x: 20, y: 80 } });
      await transcript.evaluate((el) => {
        el.scrollTop = 300;
        el.dispatchEvent(new Event("scroll"));
      });
      const before = await transcript.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const node = [
          ...el.querySelectorAll<HTMLElement>("[data-message-id]"),
        ].find((n) => n.getBoundingClientRect().bottom > top)!;
        return {
          id: node.dataset.messageId!,
          offset: node.getBoundingClientRect().top - top,
        };
      });
      const anchored = async () =>
        Math.abs(
          (await transcript.evaluate(
            (el, id) =>
              el
                .querySelector<HTMLElement>('[data-message-id="' + id + '"]')!
                .getBoundingClientRect().top - el.getBoundingClientRect().top,
            before.id,
          )) - before.offset,
        ) < 2;
      store.message(
        cid,
        randomUUID(),
        "assistant",
        "New streamed content ".repeat(100),
        "message",
      );
      await page.waitForTimeout(1200);
      assert.ok(await anchored(), "Engaged transcript remains anchored");
      await page
        .locator('[aria-label="Message"]')
        .evaluate((el) => (el as HTMLElement).focus());
      store.message(
        cid,
        randomUUID(),
        "assistant",
        "Second stream update ".repeat(100),
        "message",
      );
      await page.waitForTimeout(1000);
      assert.ok(
        await anchored(),
        "Programmatic focus does not change engagement",
      );
      await page
        .getByRole("textbox", { name: "Search transcript" })
        .fill("HISTORICAL_SEARCH_SENTINEL");
      await page
        .getByText("HISTORICAL_SEARCH_SENTINEL", { exact: true })
        .waitFor();
      await page.getByRole("textbox", { name: "Search transcript" }).fill("");
      await page.waitForTimeout(1000);
      await page.getByLabel("Attach file", { exact: true }).setInputFiles({
        name: "note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Attachment fixture."),
      });
      await page.getByRole("button", { name: "note.txt ×" }).waitFor();
      let drop = true;
      await page.route("**/v1/commands", async (route) => {
        const input = route.request().postDataJSON();
        if (input.type === "conversation.send" && drop) {
          drop = false;
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      });
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Durable browser retry fixture");
      await page.getByRole("button", { name: "Send ↑", exact: true }).click();
      await page
        .getByRole("button", { name: "Retry saved send ↑", exact: true })
        .waitFor();
      await page.reload();
      await page
        .getByRole("button", { name: "Retry saved send ↑", exact: true })
        .click();
      await page
        .getByRole("link", { name: "note.txt ↗", exact: true })
        .waitFor();
      assert.equal(
        (
          store.db
            .prepare(
              "SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='user'",
            )
            .get(cid) as any
        ).n,
        1,
        "Response loss and browser reload do not duplicate an accepted message",
      );
      await page.unroute("**/v1/commands");
      await page.getByRole("link", { name: "note.txt ↗", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByText("Attachment fixture.", { exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      let loginPending = false;
      let signedIn = false;
      const providerStatus = () => ({
        provider: "claude",
        installed: true,
        authenticated: signedIn,
        message: loginPending
          ? "Complete sign-in in your browser."
          : signedIn
            ? "Claude account connected."
            : "Sign in to Claude.",
        login: {
          state: loginPending ? "pending" : signedIn ? "succeeded" : "idle",
        },
      });
      await page.route("**/v1/providers", (route) =>
        route.fulfill({
          json: {
            providers: [
              providerStatus(),
              {
                provider: "cursor",
                installed: false,
                authenticated: false,
                message: "Install Cursor CLI to sign in.",
                login: { state: "idle" },
              },
            ],
          },
        }),
      );
      await page.route("**/v1/providers/claude/login", (route) => {
        assert.ok(route.request().headers()["x-csrf-token"]);
        loginPending = true;
        return route.fulfill({ json: providerStatus() });
      });
      await page.getByRole("button", { name: "⚙ Settings" }).click();
      await page
        .getByRole("button", { name: "Sign in to Claude", exact: true })
        .click();
      await page
        .getByText("Complete sign-in in your browser.", { exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Cancel Claude sign-in", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Sign in to Cursor", exact: true })
          .isDisabled(),
        true,
      );
      signedIn = true;
      loginPending = false;
      await page
        .getByRole("button", { name: "Refresh sign-in status", exact: true })
        .click();
      await page
        .getByText("Claude account connected.", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByText("Development home. Live ownership has not transferred.", {
            exact: true,
          })
          .count(),
        0,
      );

      await page.getByLabel("Appearance").selectOption("dark");
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "dark",
      );
      await page.keyboard.press("Escape");
      await page.reload();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "dark",
      );
      assert.equal(
        await page
          .getByText("Reading position protected", { exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: "Artifacts", exact: true })
        .click();
      await page
        .getByRole("button")
        .filter({ has: page.getByText("note.txt", { exact: true }) })
        .click();
      await page
        .getByRole("dialog")
        .getByText("Attachment fixture.", { exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      await page
        .getByRole("button")
        .filter({ has: page.getByText("sandbox.html", { exact: true }) })
        .click();
      await page
        .frameLocator(".artifact-reader iframe")
        .getByText("Parent access blocked", { exact: false })
        .waitFor();
      assert.equal(
        await page.locator("body").getAttribute("data-escaped"),
        null,
      );
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Context", exact: true }).click();
      await page.getByLabel("Context session").waitFor();
      await page.getByRole("button", { name: "Work", exact: true }).click();
      await page.locator(".sidebar").focus();
      await page.keyboard.press("Alt+ArrowRight");
      await page.waitForTimeout(100);
      const width = await page
        .locator(".sidebar")
        .evaluate((el) => el.getBoundingClientRect().width);
      assert.equal(width, 272);
      await page.reload();
      await page.locator(".sidebar").waitFor();
      assert.equal(
        await page
          .locator(".sidebar")
          .evaluate((el) => el.getBoundingClientRect().width),
        272,
      );
      await page
        .getByRole("button", { name: "New ticket", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
        true,
      );
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Work", exact: true }).click();
      for (const [decision, options] of [
        ["accept", [{ kind: "allow_once", optionId: "once" }]],
        ["decline", [{ kind: "allow_always", optionId: "always" }]],
      ] as const) {
        const permissionId = randomUUID();
        store.db
          .prepare("INSERT INTO permissions VALUES(?,?,?,?)")
          .run(
            permissionId,
            cid,
            "pending",
            JSON.stringify({
              method: "cursor/tool",
              incarnation: 0,
              params: {
                toolCall: { title: "Cursor permission fixture" },
                options,
              },
            }),
          );
        await page.reload();
        await page.getByText("Permission requested", { exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Allow once", exact: true })
            .isDisabled(),
          decision === "decline",
        );
        await page
          .getByRole("button", {
            name: decision === "accept" ? "Allow once" : "Deny",
            exact: true,
          })
          .click();
        await page
          .getByText("Permission requested", { exact: true })
          .waitFor({ state: "hidden" });
        assert.equal(
          (
            store.db
              .prepare("SELECT state FROM permissions WHERE id=?")
              .get(permissionId) as any
          ).state,
          "answering",
        );
        const outbox = store.db
          .prepare(
            "SELECT payload FROM outbox WHERE kind='permission.reply' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as any;
        assert.equal(JSON.parse(outbox.payload).decision, decision);
      }
      const reviewTicket = store.command(
        { kind: "user", id: "test" },
        {
          commandId: randomUUID(),
          type: "ticket.create",
          payload: { title: "Review notification fixture" },
        },
      ).ticket;
      store.putTicket({ ...reviewTicket, status: "awaiting_decision" });
      store.event("ticket.updated", reviewTicket.id, {}, reviewTicket.id);
      await page
        .getByRole("button", {
          name: "1 tickets need your review",
          exact: true,
        })
        .waitFor();
      await page
        .getByRole("button", {
          name: "1 tickets need your review",
          exact: true,
        })
        .click();
      await page
        .getByRole("heading", {
          name: "Review notification fixture",
          exact: true,
        })
        .waitFor();
      store.putTicket({ ...reviewTicket, status: "completed" });
      store.event("ticket.updated", reviewTicket.id, {}, reviewTicket.id);
      await page
        .getByRole("button", {
          name: "0 tickets need your review",
          exact: true,
        })
        .waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("button", { name: "New ticket", exact: true })
        .click();
      assert.ok(
        (await page
          .getByRole("dialog")
          .evaluate((el) => el.getBoundingClientRect().right)) <= 390,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      web.close();
      store.db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
