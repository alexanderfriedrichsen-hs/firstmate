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
      await page.getByRole("button", { name: "⚙ Settings" }).click();
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
