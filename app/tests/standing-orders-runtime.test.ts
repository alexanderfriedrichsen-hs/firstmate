import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { Runtime } from "../src/server/runtime.ts";
import { homePath } from "../src/server/home.ts";

async function waitFor(read: () => any, valid: (v: any) => boolean) {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (valid(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Native fixture did not reach expected state");
}
function json(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function lines(file: string): any[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
function fixture() {
  const home = homePath(
    fs.mkdtempSync(path.join(os.tmpdir(), "fm-orders-runtime-")),
  );
  const store = new Store(home);
  store.fence();
  const runtime = new Runtime(store);
  const bin = path.join(home, "fixture-bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  const wire = path.join(home, "wire.jsonl");
  for (const provider of ["codex", "cursor-agent"])
    fs.writeFileSync(
      path.join(bin, provider),
      `#!${process.execPath}
const fs=require('node:fs');const rl=require('node:readline');
const write=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(wire)},line+'\\n');
if(!m.id)return;
let result={};
if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true}};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId||'codex-exact'},model:'fake'};
if(m.method==='session/new')result={sessionId:'cursor-exact'};
if(m.method==='session/prompt')result={stopReason:'end_turn'};
if(m.method==='session/set_model' && fs.existsSync(${JSON.stringify(path.join(home, "delay-model-once"))})){fs.unlinkSync(${JSON.stringify(path.join(home, "delay-model-once"))});setTimeout(()=>write({id:m.id,result}),500);return;}
write({id:m.id,result});
});`,
      { mode: 0o700 },
    );
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previousPath;
  const runners: any[] = [];
  const command = (type: string, payload: any = {}) =>
    store.command(
      { kind: "user", id: "test" },
      { commandId: randomUUID(), type, payload },
    );
  const launch = async (c: any) => {
    await runtime.launch(c);
    const dir = path.join(home, "app/runners", c.runnerId);
    const identity = await waitFor(
      () => json(path.join(dir, "identity.json")),
      (v) => v.state === "idle",
    );
    runners.push(identity);
    return { dir, config: json(path.join(dir, "config.json")), identity };
  };
  const stop = async (identity: any) => {
    try {
      process.kill(identity.pid, "SIGTERM");
    } catch {}
    await waitFor(() => {
      try {
        process.kill(identity.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    await waitFor(() => {
      try {
        process.kill(identity.providerPid, 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean);
  };
  return {
    home,
    store,
    runtime,
    wire,
    command,
    launch,
    stop,
    async close() {
      for (const identity of runners) await stop(identity);
      process.env.PATH = previousPath;
      store.db.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test(
  "native startup and exact resume load current scoped context with provenance, while workers receive no private home sources",
  { timeout: 20000 },
  async () => {
    const f = fixture();
    try {
      fs.writeFileSync(
        path.join(f.home, "data/captain.md"),
        "PRIVATE_CAPTAIN_V1",
      );
      fs.writeFileSync(
        path.join(f.home, "data/backlog.md"),
        "RAW_BACKLOG_SECRET",
      );
      const visible = f.command("ticket.create", {
        title: "Visible task",
        handling: "agent_managed",
      }).ticket;
      const hidden = f.command("ticket.create", {
        title: "HUMAN_ONLY_SECRET",
        handling: "human_only",
      }).ticket;
      for (const [ticketId, text] of [
        [visible.id, "VISIBLE_WAKE"],
        [hidden.id, "PRIVATE_WAKE_SECRET"],
      ])
        f.store.db
          .prepare("INSERT INTO wakes VALUES(?,?,?,?,?)")
          .run(
            randomUUID(),
            ticketId,
            "pending",
            JSON.stringify({ kind: "worker.completed", text }),
            new Date().toISOString(),
          );
      const c = f.command("conversation.create", {
        role: "supervisor",
        provider: "codex",
        model: "fake",
      }).conversation;
      const first = await f.launch(c);
      assert.match(first.config.instructions, /PRIVATE_CAPTAIN_V1/);
      assert.match(first.config.instructions, /Visible task/);
      assert.match(first.config.instructions, /worker.completed/);
      assert.doesNotMatch(
        first.config.instructions,
        /HUMAN_ONLY_SECRET|PRIVATE_WAKE_SECRET|RAW_BACKLOG_SECRET/,
      );
      const source = f.store
        .setting("context:" + c.id)
        .find((row: any) => row.path === path.join(f.home, "data/captain.md"));
      assert.equal(source.incarnation, c.incarnation);
      assert.equal(
        fs.readFileSync(
          path.join(f.home, "app/objects", source.artifactId),
          "utf8",
        ),
        "PRIVATE_CAPTAIN_V1",
      );
      const captured = f.store
        .setting("context:" + c.id)
        .find((row: any) => row.name === "firstmate-startup-snapshot.json");
      const snapshot = JSON.parse(
        fs.readFileSync(
          path.join(f.home, "app/objects", captured.artifactId),
          "utf8",
        ),
      );
      assert.ok(snapshot.tickets.some((t: any) => t.id === visible.id));
      assert.ok(!snapshot.tickets.some((t: any) => t.id === hidden.id));
      assert.ok(!JSON.stringify(snapshot).includes("PRIVATE_WAKE_SECRET"));
      const start = lines(f.wire).find((m) => m.method === "thread/start");
      assert.equal(
        start.params.developerInstructions,
        first.config.instructions,
      );
      await f.stop(first.identity);
      c.providerId = "codex-exact";
      fs.writeFileSync(
        path.join(f.home, "data/captain.md"),
        "PRIVATE_CAPTAIN_V2",
      );
      const second = await f.launch(c);
      assert.match(second.config.instructions, /PRIVATE_CAPTAIN_V2/);
      assert.doesNotMatch(second.config.instructions, /PRIVATE_CAPTAIN_V1/);
      const resume = lines(f.wire).find((m) => m.method === "thread/resume");
      assert.equal(resume.params.threadId, "codex-exact");
      assert.equal(
        resume.params.developerInstructions,
        second.config.instructions,
      );
      assert.equal(
        f.store
          .setting("context:" + c.id)
          .filter((row: any) => row.path?.endsWith("data/captain.md")).length,
        2,
      );
      await f.stop(second.identity);
      const worker = {
        ...c,
        id: randomUUID(),
        role: "worker",
        ticketId: visible.id,
        runnerId: undefined,
        incarnation: 0,
        cwd: path.join(f.home, "worker"),
        providerId: "worker-exact",
      };
      fs.mkdirSync(worker.cwd, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: worker.cwd });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/example/worker"],
        { cwd: worker.cwd },
      );
      f.store.setting("project", {
        source: worker.cwd,
        remote: "https://github.com/example/worker",
      });
      f.store.bindProject(worker, {
        id: "default",
        source: worker.cwd,
        remote: "https://github.com/example/worker",
        requiredChecks: [],
      });
      f.store.putConversation(worker as any);
      const work = await f.launch(worker);
      assert.doesNotMatch(
        work.config.instructions,
        /PRIVATE_CAPTAIN|Visible task|Startup fleet snapshot/,
      );
      assert.ok(
        f.store.setting("context:" + worker.id).every((row: any) => !row.path),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "Cursor receives full standing orders only on the first prompt of each exact-resume incarnation",
  { timeout: 20000 },
  async () => {
    const f = fixture();
    try {
      fs.writeFileSync(
        path.join(f.home, "data/captain.md"),
        "PRIVATE_CURSOR_ORDERS",
      );
      f.command("provider.cursor.subscription");
      f.store.setting("providerModelCatalog.cursor", [
        { model: "fake", supportedReasoningEfforts: [] },
      ]);
      const c = f.command("conversation.create", {
        role: "supervisor",
        provider: "cursor",
        model: "fake",
      }).conversation;
      for (let incarnation = 0; incarnation < 2; incarnation++) {
        const launched = await f.launch(c);
        for (let turn = 0; turn < 2; turn++) {
          const before = lines(f.wire).filter(
            (m) => m.method === "session/prompt",
          ).length;
          await f.runtime.request(c, {
            id: randomUUID(),
            type: "send",
            text: `Turn ${incarnation}-${turn}`,
          });
          await waitFor(
            () => lines(f.wire).filter((m) => m.method === "session/prompt"),
            (v) => v.length > before,
          );
          await waitFor(
            () => json(path.join(launched.dir, "identity.json")),
            (v) => v.state === "idle",
          );
          const prompt = lines(f.wire)
            .filter((m) => m.method === "session/prompt")
            .at(-1).params.prompt[0].text;
          if (turn === 0) assert.match(prompt, /PRIVATE_CURSOR_ORDERS/);
          else {
            assert.doesNotMatch(prompt, /PRIVATE_CURSOR_ORDERS/);
            assert.match(prompt, /Firstmate standing orders/);
          }
        }
        await f.stop(launched.identity);
        c.providerId = "cursor-exact";
      }
      assert.equal(
        lines(f.wire).filter((m) => m.method === "session/new").length,
        1,
      );
      assert.equal(
        lines(f.wire).find((m) => m.method === "session/load").params.sessionId,
        "cursor-exact",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "Cursor cancellation before native prompt delivery preserves full startup context for the next turn",
  { timeout: 20000 },
  async () => {
    const f = fixture();
    try {
      fs.writeFileSync(
        path.join(f.home, "data/captain.md"),
        "REQUIRED_CONTEXT_AFTER_CANCEL",
      );
      fs.writeFileSync(path.join(f.home, "delay-model-once"), "hold");
      f.command("provider.cursor.subscription");
      f.store.setting("providerModelCatalog.cursor", [
        { model: "fake", supportedReasoningEfforts: [] },
      ]);
      const c = f.command("conversation.create", {
        role: "supervisor",
        provider: "cursor",
        model: "fake",
      }).conversation;
      const launched = await f.launch(c);
      await f.runtime.request(c, {
        id: randomUUID(),
        type: "send",
        text: "Cancelled before provider sees this",
      });
      await waitFor(
        () => lines(f.wire),
        (v) => v.some((m: any) => m.method === "session/set_model"),
      );
      await f.runtime.request(c, { id: randomUUID(), type: "interrupt" });
      await waitFor(
        () => json(path.join(launched.dir, "identity.json")),
        (v) => v.state === "idle",
      );
      assert.equal(
        lines(f.wire).filter((m) => m.method === "session/prompt").length,
        0,
      );
      await f.runtime.request(c, {
        id: randomUUID(),
        type: "send",
        text: "Continue with actual startup context",
      });
      await waitFor(
        () => lines(f.wire),
        (v) => v.some((m: any) => m.method === "session/prompt"),
      );
      await waitFor(
        () => json(path.join(launched.dir, "identity.json")),
        (v) => v.state === "idle",
      );
      const prompt = lines(f.wire).find((m) => m.method === "session/prompt")
        .params.prompt[0].text;
      assert.match(prompt, /REQUIRED_CONTEXT_AFTER_CANCEL/);
    } finally {
      await f.close();
    }
  },
);
