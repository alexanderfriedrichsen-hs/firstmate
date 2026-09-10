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
import type { Conversation } from "../src/contracts.ts";

test(
  "browser preserves reading position, searches old history, and saves panel width",
  { timeout: 60000 },
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
      const bottomGap = () =>
        transcript.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        );
      const streamId = randomUUID();
      await page.getByRole("textbox", { name: "Message", exact: true }).click();
      for (let delta = 1; delta <= 3; delta++) {
        store.message(
          cid,
          streamId,
          "assistant",
          "Streaming follow fixture\n".repeat(delta * 30),
          "message",
        );
        await page.waitForTimeout(180);
        assert.ok(
          (await bottomGap()) < 3,
          "Streaming follows bottom after composer interaction",
        );
      }
      await transcript.click({ position: { x: 20, y: 80 } });
      await transcript.hover();
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(150);
      assert.ok((await bottomGap()) > 600, "User scrolling up pauses follow");
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
      const cid2 = randomUUID();
      const conv2: Conversation = {
        id: cid2,
        provider: "codex",
        model: "fixture",
        role: "supervisor",
        cwd: home,
        incarnation: 0,
        state: "idle",
        inputOwner: "automation",
        version: 1,
        retiredAt: new Date().toISOString(),
      };
      store.putConversation(conv2);
      store.event("conversation.updated", cid2, conv2);
      await transcript.evaluate((el) =>
        el.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
        ),
      );
      const historySelect = page.getByLabel("Firstmate chat history");
      await historySelect.waitFor();
      await historySelect.selectOption(cid2);
      await transcript.waitFor();
      await transcript.evaluate((el) =>
        el.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true }),
        ),
      );
      await historySelect.selectOption(cid);
      await transcript.waitFor();
      store.message(
        cid,
        randomUUID(),
        "assistant",
        "Resumed after mid pointer-drag unmount ".repeat(50),
        "message",
      );
      await page.waitForTimeout(1200);
      assert.ok(
        await anchored(),
        "Reading position survives switching conversations",
      );
      await page
        .getByRole("button", {
          name: "New content · Jump to latest ↓",
          exact: true,
        })
        .click();
      store.message(
        cid,
        randomUUID(),
        "assistant",
        "Follow after jump\n".repeat(50),
        "message",
      );
      await page.waitForTimeout(200);
      assert.ok((await bottomGap()) < 3, "Jump resumes following later deltas");
      await transcript.evaluate((el) => {
        el.scrollTop -= 250;
        el.dispatchEvent(new Event("scroll"));
      });
      await transcript.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      });
      await page.getByRole("textbox", { name: "Message", exact: true }).click();
      store.message(
        cid,
        randomUUID(),
        "assistant",
        "Follow after manual bottom\n".repeat(50),
        "message",
      );
      await page.waitForTimeout(200);
      assert.ok(
        (await bottomGap()) < 3,
        "Returning to bottom resumes following",
      );
      await historySelect.selectOption(cid2);
      await historySelect.selectOption(cid);
      store.message(
        cid,
        randomUUID(),
        "assistant",
        "Follow after switching\n".repeat(50),
        "message",
      );
      await page.waitForTimeout(200);
      assert.ok(
        (await bottomGap()) < 3,
        "Following chat stays following after switching",
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
      await page.route("**/v1/catalog?topic=skills&conversationId=*", (route) =>
        route.fulfill({
          json: {
            data: [
              {
                skills: [
                  {
                    name: "no-mistakes",
                    path: "/fixture/no-mistakes/SKILL.md",
                    description: "Validate changes before shipping",
                    enabled: true,
                  },
                ],
              },
            ],
          },
        }),
      );
      await page.route("**/v1/conversations/" + cid, async (route) => {
        const response = await route.fetch();
        const detail = await response.json();
        await route.fulfill({
          json: {
            ...detail,
            nativeCommands: [
              { name: "compact", description: "Compact this provider session" },
            ],
          },
        });
      });
      store.event("conversation.updated", cid, {});
      const slashComposer = page.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      await slashComposer.fill("/");
      await page
        .getByRole("listbox", { name: "Skills and commands" })
        .waitFor();
      await page
        .getByRole("option")
        .filter({ hasText: "/no-mistakes" })
        .waitFor();
      await slashComposer.press("ArrowDown");
      assert.equal(
        await page
          .getByRole("option")
          .filter({ hasText: "/artifacts" })
          .getAttribute("aria-selected"),
        "true",
      );
      await slashComposer.fill("/no-mis");
      await slashComposer.press("Enter");
      assert.equal(await slashComposer.inputValue(), "Use $no-mistakes to ");
      await page
        .getByRole("button", { name: "$no-mistakes ×", exact: true })
        .waitFor();
      let skillPayload: any;
      await page.route("**/v1/commands", (route) => {
        skillPayload = route.request().postDataJSON();
        return route.fulfill({ json: { ok: true } });
      });
      await slashComposer.press("Enter");
      await page
        .getByRole("button", { name: "$no-mistakes ×", exact: true })
        .waitFor({ state: "hidden" });
      assert.deepEqual(skillPayload.payload.skills, [
        { name: "no-mistakes", path: "/fixture/no-mistakes/SKILL.md" },
      ]);
      await page.unroute("**/v1/commands");
      const fourSkills = [1, 2, 3, 4].map((n) => ({
        name: "selected-" + n,
        path: "/fixture/selected-" + n,
      }));
      await page.evaluate(
        ({ cid, fourSkills }) =>
          localStorage.setItem("skills:" + cid, JSON.stringify(fourSkills)),
        { cid, fourSkills },
      );
      await page.reload();
      await slashComposer.fill("/no-mis");
      await page
        .getByRole("option")
        .filter({ hasText: "/no-mistakes" })
        .waitFor();
      await slashComposer.press("Enter");
      await page
        .getByRole("alert")
        .filter({ hasText: "up to four skills" })
        .waitFor();
      assert.deepEqual(
        await page.evaluate(
          (cid) => JSON.parse(localStorage.getItem("skills:" + cid)!),
          cid,
        ),
        fourSkills,
      );
      for (const skill of fourSkills)
        await page
          .getByRole("button", { name: "$" + skill.name + " ×", exact: true })
          .click();
      await slashComposer.fill("/compact");
      await page
        .getByRole("option")
        .filter({ hasText: "Provider command" })
        .waitFor();
      await slashComposer.press("Tab");
      assert.equal(await slashComposer.inputValue(), "/compact ");
      assert.equal(
        await page
          .getByRole("button", { name: "$compact ×", exact: true })
          .count(),
        0,
      );
      await page.unroute("**/v1/conversations/" + cid);
      await slashComposer.fill("/context");
      await slashComposer.press("Escape");
      await page
        .getByRole("listbox", { name: "Skills and commands" })
        .waitFor({ state: "hidden" });
      assert.equal(await slashComposer.inputValue(), "/context");
      await slashComposer.fill("/skills");
      await slashComposer.press("Shift+Enter");
      assert.equal(await slashComposer.inputValue(), "/skills\n");
      await slashComposer.fill("/context");
      await slashComposer.press("Tab");
      await page.getByLabel("Context session").waitFor();
      await page.getByRole("button", { name: "Work", exact: true }).click();
      await page.getByLabel("Attach file", { exact: true }).setInputFiles({
        name: "note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Attachment fixture."),
      });
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
      const composer = page.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      await composer.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
      });
      await page.waitForTimeout(100);
      assert.equal(drop, true, "IME composition Enter does not send a message");
      await composer.press("End");
      await composer.press("Shift+Enter");
      assert.equal(
        await composer.inputValue(),
        "Durable browser retry fixture\n",
      );
      await composer.press("Backspace");
      await composer.press("Enter");
      assert.equal(
        await composer.inputValue(),
        "Durable browser retry fixture",
        "Enter submits without adding a newline",
      );
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

      await page
        .getByRole("button", {
          name: "Use subscription usage reporting",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: "Use subscription usage reporting",
          exact: true,
        })
        .waitFor({ state: "hidden" });
      assert.equal(store.setting("policy").cursor.mode, "subscription_usage");
      const heartbeatInterval = page.getByLabel("Check every (minutes)");
      await heartbeatInterval.fill("121");
      assert.equal(
        await page
          .getByRole("button", { name: "Save heartbeat", exact: true })
          .isDisabled(),
        true,
      );
      await heartbeatInterval.fill("2");
      await page.getByLabel("Enable heartbeat", { exact: true }).check();
      await page.route("**/v1/commands", (route) =>
        route.fulfill({
          status: 409,
          json: { error: "Heartbeat settings could not be saved" },
        }),
      );
      await page
        .getByRole("button", { name: "Save heartbeat", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Heartbeat settings could not be saved" })
        .waitFor();
      assert.equal(await heartbeatInterval.inputValue(), "2");
      await page.unroute("**/v1/commands");
      await page
        .getByRole("button", { name: "Save heartbeat", exact: true })
        .click();
      await page
        .getByText("Heartbeat settings saved.", { exact: true })
        .waitFor();
      assert.equal(store.setting("heartbeat").enabled, true);
      assert.equal(store.setting("heartbeat").intervalMinutes, 2);
      await page.getByLabel("Enable heartbeat", { exact: true }).uncheck();
      await page
        .getByRole("button", { name: "Save heartbeat", exact: true })
        .click();
      await page
        .getByText("Heartbeat settings saved.", { exact: true })
        .waitFor();
      assert.equal(store.setting("heartbeat").enabled, false);
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
      await page.route("**/v1/usage", (route) =>
        route.fulfill({
          json: {
            observations: [
              {
                model: "unknown-usage-fixture",
                input: null,
                output: null,
                observed_at: new Date().toISOString(),
                conversation_id: cid,
                data: { provider: "cursor", role: "supervisor" },
              },
            ],
          },
        }),
      );
      await page.route("**/v1/catalog?topic=account*", (route) =>
        route.fulfill({ json: {} }),
      );
      await page
        .getByRole("button", { name: "Dashboards", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Usage by model", exact: true })
        .waitFor();
      const usageRow = page
        .getByRole("row")
        .filter({ hasText: "unknown-usage-fixture" });
      await usageRow.waitFor();
      assert.equal(
        await usageRow
          .getByRole("cell", { name: "Unavailable", exact: true })
          .count(),
        3,
      );
      assert.equal(
        await page.getByText("Cursor budget", { exact: true }).count(),
        0,
      );
      await page
        .getByText("Subscription usage reporting is enabled.", { exact: true })
        .waitFor();
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
      const questionId = randomUUID();
      store.db.prepare("INSERT INTO permissions VALUES(?,?,?,?)").run(
        questionId,
        cid,
        "pending",
        JSON.stringify({
          kind: "question",
          method: "fixture/question",
          url: "https://example.com/sign-in",
          incarnation: 0,
          questions: [
            {
              id: "choice",
              header: "Direction",
              question: "Which direction?",
              options: [
                { label: "North", description: "Go north" },
                { label: "South" },
              ],
              isOther: false,
            },
            {
              id: "note",
              header: "Details",
              question: "Any details?",
              isSecret: true,
            },
          ],
        }),
      );
      await page.reload();
      const questionForm = page.getByRole("form", {
        name: "Questions from Firstmate",
      });
      await questionForm.waitFor();
      assert.equal(
        await questionForm
          .getByRole("link", { name: "Open provider sign-in", exact: true })
          .getAttribute("href"),
        "https://example.com/sign-in",
      );
      assert.equal(
        await questionForm
          .getByRole("button", { name: "Send answers", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await questionForm
          .getByRole("button", { name: "Allow once", exact: true })
          .count(),
        0,
      );
      await questionForm.getByRole("radio", { name: "North Go north" }).check();
      await questionForm
        .getByLabel("Details answer")
        .fill("private fixture reply");
      await page.route("**/v1/commands", (route) =>
        route.fulfill({
          status: 409,
          json: { error: "Question answer could not be saved. Try again." },
        }),
      );
      await questionForm
        .getByRole("button", { name: "Send answers", exact: true })
        .click();
      await questionForm
        .getByRole("alert")
        .filter({ hasText: "Question answer could not be saved" })
        .waitFor();
      assert.equal(
        await questionForm.getByLabel("Details answer").inputValue(),
        "private fixture reply",
      );
      assert.equal(
        await questionForm
          .getByRole("radio", { name: "North Go north" })
          .isChecked(),
        true,
      );
      await page.unroute("**/v1/commands");
      await questionForm
        .getByRole("button", { name: "Send answers", exact: true })
        .click();
      await questionForm.waitFor({ state: "hidden" });
      const questionOutbox = store.db
        .prepare(
          "SELECT payload FROM outbox WHERE kind='permission.reply' ORDER BY rowid DESC LIMIT 1",
        )
        .get() as any;
      assert.deepEqual(JSON.parse(questionOutbox.payload).answers, {
        choice: { answers: ["North"] },
        note: { answers: ["private fixture reply"] },
      });
      assert.equal(
        await page.evaluate(() =>
          JSON.stringify(localStorage).includes("private fixture reply"),
        ),
        false,
      );
      const unsupportedId = randomUUID();
      store.db.prepare("INSERT INTO permissions VALUES(?,?,?,?)").run(
        unsupportedId,
        cid,
        "pending",
        JSON.stringify({
          method: "mcpServer/elicitation/request",
          incarnation: 0,
          params: { requestedSchema: { type: "object" } },
        }),
      );
      await page.reload();
      await page
        .getByText("Provider request needs attention", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Allow once", exact: true })
          .count(),
        0,
      );
      const stopped = page.waitForResponse(
        (response) =>
          response.url().endsWith("/v1/commands") &&
          response.request().postDataJSON().type === "conversation.interrupt",
      );
      await page
        .getByRole("button", { name: "Stop this turn", exact: true })
        .click();
      await stopped;
      const stop = store.db
        .prepare("SELECT kind FROM outbox ORDER BY rowid DESC LIMIT 1")
        .get() as any;
      assert.equal(stop.kind, "conversation.interrupt");
      store.db
        .prepare("UPDATE permissions SET state='expired' WHERE id=?")
        .run(unsupportedId);
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
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.clock.install({ time: new Date() });
      store.setting("heartbeat", {
        enabled: true,
        intervalMinutes: 10,
        lastTickAt: new Date().toISOString(),
        lastCheckAt: new Date().toISOString(),
        nextCheckAt: new Date(Date.now() + 600000).toISOString(),
        issues: [],
        summary: "Dispatch is paused.",
      });
      store.event("heartbeat.updated", "heartbeat", {});
      await page
        .getByRole("button", { name: "Dashboards", exact: true })
        .click();
      await page
        .getByRole("region", { name: "Heartbeat status" })
        .getByText("Paused", { exact: true })
        .waitFor();
      const freshTick = new Date(Date.now() + 45000).toISOString();
      store.setting("heartbeat", {
        ...store.setting("heartbeat"),
        lastTickAt: freshTick,
      });
      const heartbeatPoll = page.waitForResponse((response) =>
        response.url().endsWith("/v1/heartbeat"),
      );
      await page.clock.fastForward(75000);
      await heartbeatPoll;
      await page
        .getByRole("region", { name: "Heartbeat status" })
        .getByText("Paused", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", {
            name: "Heartbeat needs attention",
            exact: true,
          })
          .count(),
        0,
        "Fresh heartbeat poll prevents false stale status without snapshot events",
      );
      await page.route("**/v1/heartbeat", (route) => route.abort("failed"));
      await page.clock.fastForward(45000);
      await page
        .getByRole("region", { name: "Heartbeat status" })
        .getByText("Heartbeat overdue", { exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Heartbeat needs attention", exact: true })
        .waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      web.close();
      store.db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
