import { mcpApproval, mcpQuestions, mcpAnswer } from "./elicitation.ts";
import {
  normalizeQuestions,
  claudeToolHandler,
  validateQuestionAnswers,
  claudeQuestionInput,
  codexApproval,
  fullAccessThread,
  fullAccessTurn,
  fullAccessClaude,
  type Question,
} from "./questions.ts";
import fs from "node:fs";
import { subscriptionEnv } from "./provider-auth.ts";
import { CursorACP } from "./cursor-acp.ts";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadStartParams } from "../protocol/v2/ThreadStartParams";
import type { TurnStartParams } from "../protocol/v2/TurnStartParams";
import { atomic, processIdentity } from "./home.ts";
const file = process.argv[2];
let cursorInstructionsSent = false;
const config = JSON.parse(fs.readFileSync(file, "utf8"));
const dir = path.dirname(file);
let seq = 0;
let threadId = config.providerId;
let turnId: string | undefined;
let state = "starting";
let claude: Query | undefined;
let cursor: CursorACP | undefined;
let claudeInterrupted = false;
const commands = new Map<string, any>();
const permissions = new Map<
  string,
  {
    id: any;
    method: string;
    input?: any;
    questions?: Question[];
    resolve?: (answer: any) => void;
  }
>();
const journal = fs.openSync(path.join(dir, "events.jsonl"), "a", 0o600);
function emit(type: string, payload: any) {
  const event = {
    runnerId: config.runnerId,
    incarnation: config.incarnation,
    sequence: ++seq,
    type,
    payload,
    at: new Date().toISOString(),
  };
  fs.writeSync(journal, JSON.stringify(event) + "\n");
  fs.fsyncSync(journal);
}
function identity() {
  atomic(
    path.join(dir, "identity.json"),
    JSON.stringify({
      pid: process.pid,
      providerPid: child?.pid ?? cursor?.child.pid,
      providerStartIdentity:
        (child?.pid ?? cursor?.child.pid)
          ? processIdentity((child?.pid ?? cursor?.child.pid)!)
          : undefined,
      startIdentity: processIdentity(),
      providerId: threadId,
      turnId,
      state,
      socket: config.socket,
      runnerId: config.runnerId,
      incarnation: config.incarnation,
    }),
  );
}
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: any) => void }
>();
let rid = 0;
const activeItems = new Map<string, unknown>();
const child =
  config.provider === "codex"
    ? spawn(config.executable, ["app-server", "--stdio"], {
        cwd: config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...subscriptionEnv(),
        },
      })
    : undefined;
function rpc(method: string, params: any) {
  return new Promise<any>((resolve, reject) => {
    const id = ++rid;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error("Provider response timed out; delivery remains uncertain"),
      );
    }, 30000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
if (child) {
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      emit("protocol.malformed", { preview: line.slice(0, 500) });
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      const approval =
        codexApproval(msg.method, msg.params) ??
        (msg.method === "mcpServer/elicitation/request"
          ? mcpApproval(msg.params)
          : undefined);
      if (approval !== undefined) {
        child!.stdin.write(
          JSON.stringify({ id: msg.id, result: approval }) + "\n",
        );
        emit("permission.autoApproved", { method: msg.method });
        return;
      }
      if (msg.method === "item/tool/requestUserInput") {
        try {
          const id = randomUUID();
          const questions = normalizeQuestions("codex", msg.params);
          permissions.set(id, { id: msg.id, method: msg.method, questions });
          emit("permission.request", {
            id,
            kind: "question",
            method: msg.method,
            questions,
            incarnation: config.incarnation,
          });
          state = "waiting_permission";
          identity();
        } catch {
          child!.stdin.write(
            JSON.stringify({
              id: msg.id,
              error: { code: -32602, message: "Unsupported question format" },
            }) + "\n",
          );
        }
        return;
      }
      if (msg.method === "mcpServer/elicitation/request") {
        try {
          const id = randomUUID();
          const form = mcpQuestions(msg.params);
          permissions.set(id, {
            id: msg.id,
            method: msg.method,
            questions: form.questions,
            input: msg.params,
          });
          emit("permission.request", {
            id,
            kind: "question",
            method: msg.method,
            ...form,
            elicitation: {
              mode: msg.params.mode,
              requestedSchema: msg.params.requestedSchema,
            },
            incarnation: config.incarnation,
          });
          state = "waiting_permission";
          identity();
          return;
        } catch {
          /* Unsupported schemas remain visible without a fake approval action. */
        }
      }
      const id = randomUUID();
      permissions.set(id, { id: msg.id, method: msg.method });
      emit("permission.request", {
        id,
        kind: "unsupported",
        requestId: msg.id,
        method: msg.method,
        message:
          "This provider request is not supported. Stop this turn and resume after updating the integration.",
        incarnation: config.incarnation,
      });
      state = "waiting_permission";
      identity();
      return;
    }
    if (msg.method === "serverRequest/resolved") {
      let resolved = false;
      for (const [id, request] of permissions)
        if (request.id === msg.params?.requestId) {
          permissions.delete(id);
          emit("permission.resolved", { id });
          resolved = true;
        }
      if (resolved && state === "waiting_permission") {
        state = permissions.size ? "waiting_permission" : "running";
        identity();
      }
    }
    if (msg.method === "item/started" && msg.params?.item?.id)
      activeItems.set(msg.params.item.id, msg.params.item);
    if (msg.method === "item/completed" && msg.params?.item?.id)
      activeItems.delete(msg.params.item.id);
    emit("provider.event", msg);
    if (msg.method === "turn/started") {
      turnId = msg.params.turn.id;
      state = "running";
      identity();
    }
    if (msg.method === "turn/completed") {
      permissions.clear();
      emit("permission.expired", {});
      state = "idle";
      turnId = undefined;
      identity();
    }
  });
  child.stderr.on("data", (data) => {
    fs.appendFileSync(path.join(dir, "provider.stderr"), data, { mode: 0o600 });
  });
  child.on("exit", (code, signal) => {
    state = "lost";
    emit("provider.exit", { code, signal });
    identity();
    for (const p of pending.values()) p.reject(new Error("Provider exited"));
    pending.clear();
  });
}
async function init() {
  if (config.provider === "cursor") {
    cursor = new CursorACP(config.executable, config.cwd, (type, payload) => {
      if (type === "permission.request") {
        permissions.set(payload.id, {
          id: payload.id,
          method:
            payload.kind === "question" ? "cursor/question" : "cursor/tool",
          questions: payload.questions,
        });
        state = "waiting_permission";
      }
      if (type === "provider.exit") state = "lost";
      if (type === "permission.expired") permissions.clear();
      emit(
        type,
        type === "permission.request"
          ? { ...payload, incarnation: config.incarnation }
          : payload,
      );
      identity();
    });
    threadId = await cursor.initialize(config.cwd, threadId);
    emit("conversation.bound", { providerId: threadId, model: config.model });
  }
  if (child) {
    await rpc("initialize", {
      clientInfo: { name: "firstmate_local", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const params: ThreadStartParams = {
      cwd: config.cwd,
      model: config.model,
      ...fullAccessThread,
      developerInstructions: config.instructions,
    };
    const result = await rpc(
      threadId ? "thread/resume" : "thread/start",
      threadId ? { ...params, threadId } : params,
    );
    threadId = result.thread.id;
    emit("conversation.bound", {
      providerId: threadId,
      model: result.model,
      thread: result.thread,
    });
  }
  state = "idle";
  identity();
  emit("runner.ready", { providerId: threadId });
}
async function claudeTurn(
  text: string,
  model = config.model,
  effort = config.effort,
) {
  claudeInterrupted = false;
  state = "running";
  identity();
  try {
    claude = query({
      prompt: text,
      options: {
        cwd: config.cwd,
        model,
        effort,
        resume: threadId,
        pathToClaudeCodeExecutable: config.executable,
        settingSources: ["user", "project", "local"],
        ...fullAccessClaude,
        includePartialMessages: true,
        maxTurns: config.maxTurns ?? 8,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: config.instructions,
        },
        env: {
          ...subscriptionEnv(),
        },
        canUseTool: claudeToolHandler(async (tool, input, options) => {
          const questions = normalizeQuestions("claude", input);
          const id = randomUUID();
          emit("permission.request", {
            id,
            kind: "question",
            questions,
            method: "claude/question",
            params: { tool, input, toolUseID: options.toolUseID },
            incarnation: config.incarnation,
          });
          state = "waiting_permission";
          identity();
          return await new Promise((resolve) => {
            const abort = () => {
              permissions.delete(id);
              resolve({ behavior: "deny", message: "Request interrupted" });
              emit("permission.answered", { id, decision: "cancel" });
            };
            if (options.signal.aborted) return abort();
            options.signal.addEventListener("abort", abort, { once: true });
            permissions.set(id, {
              id,
              method: "claude/question",
              questions,
              input,
              resolve: (answer) => {
                options.signal.removeEventListener("abort", abort);
                resolve(answer);
              },
            });
          });
        }),
      },
    });
    for await (const msg of claude) {
      if (msg.type === "system" && "session_id" in msg) {
        threadId = msg.session_id;
        emit("conversation.bound", {
          providerId: threadId,
          model,
        });
        identity();
      }
      emit(
        "claude.event",
        msg.type === "result"
          ? { ...msg, firstmateInterrupted: claudeInterrupted }
          : msg,
      );
    }
    state = "idle";
    emit("runner.settled", {});
  } catch (error) {
    state = claudeInterrupted ? "idle" : "failed";
    emit(claudeInterrupted ? "runner.settled" : "runner.failed", {
      message: String(error),
      outcome: claudeInterrupted ? "interrupted" : "failed",
    });
  } finally {
    permissions.clear();
    emit("permission.expired", {});
    claude = undefined;
    identity();
  }
}
async function handle(req: any) {
  if (req.type === "status") return { state, threadId, turnId, sequence: seq };
  if (commands.has(req.id)) return commands.get(req.id);
  emit("command.dispatching", { id: req.id, type: req.type });
  commands.set(req.id, { state: "uncertain" });
  let result: any;
  if (req.type === "send" || req.type === "steer") {
    if (req.type === "send" && state !== "idle")
      throw new Error("Runner is not idle");
    if (child) {
      const params: TurnStartParams = {
        threadId,
        input: [
          { type: "text", text: req.text, text_elements: [] },
          ...(req.skills ?? []).map((skill: any) => ({
            type: "skill",
            name: skill.name,
            path: skill.path,
          })),
          ...(req.attachments ?? []).map((a: any) =>
            a.mediaType.startsWith("image/")
              ? {
                  type: "image",
                  url: "data:" + a.mediaType + ";base64," + a.base64,
                }
              : {
                  type: "text",
                  text:
                    "Attached file " +
                    a.name +
                    ":\n" +
                    Buffer.from(a.base64, "base64").toString("utf8"),
                  text_elements: [],
                },
          ),
        ],
        clientUserMessageId: req.messageId,
        model: req.model ?? config.model,
        effort: req.effort ?? config.effort,
        outputSchema: config.outputSchema,
        ...fullAccessTurn,
      };
      result = await rpc(
        req.type === "steer" ? "turn/steer" : "turn/start",
        req.type === "steer"
          ? { threadId, expectedTurnId: turnId, input: params.input }
          : params,
      );
      turnId = result.turn?.id ?? turnId;
      state = "running";
      identity();
    } else if (cursor) {
      state = "running";
      identity();
      const model = req.model ?? config.model;
      const prompt =
        (cursorInstructionsSent
          ? (config.ongoingInstructions ?? config.instructions)
          : config.instructions) +
        "\n\nUser request:\n" +
        req.text +
        (req.attachments ?? [])
          .map(
            (a: any) =>
              "\nAttached file " +
              a.name +
              ":\n" +
              Buffer.from(a.base64, "base64").toString("utf8"),
          )
          .join("");
      const hadInstructions = cursorInstructionsSent;
      cursorInstructionsSent = true;
      void cursor
        .prompt(prompt, model)
        .then((result) => {
          if (!hadInstructions && result.stopReason === "cancelled")
            cursorInstructionsSent = false;
          state = "idle";
          emit("cursor.result", { ...result, model, turn: req.id });
          emit("runner.settled", {
            outcome:
              result.stopReason === "cancelled"
                ? "interrupted"
                : result.stopReason === "end_turn"
                  ? "succeeded"
                  : "failed",
          });
        })
        .catch((error) => {
          state = "failed";
          emit("runner.failed", { message: String(error) });
        })
        .finally(() => {
          permissions.clear();
          emit("permission.expired", {});
          identity();
        });
      result = { accepted: true };
    } else {
      void claudeTurn(
        req.text +
          (req.attachments ?? [])
            .map(
              (a: any) =>
                "\nAttached file " +
                a.name +
                ":\n" +
                Buffer.from(a.base64, "base64").toString("utf8"),
            )
            .join(""),
        req.model ?? config.model,
        req.effort ?? config.effort,
      );
      result = { accepted: true };
    }
  } else if (req.type === "interrupt") {
    if (child && turnId)
      result = await rpc("turn/interrupt", { threadId, turnId });
    else if (cursor) {
      cursor.cancel();
      result = { requested: true };
    } else if (claude) {
      claudeInterrupted = true;
      for (const [id, permission] of permissions) {
        permission.resolve?.({
          behavior: "deny",
          message: "Request interrupted",
        });
        permissions.delete(id);
      }
      await claude.interrupt();
      result = { requested: true };
    } else result = { idle: true };
  } else if (req.type === "park") {
    if (state !== "idle")
      throw new Error("Active provider work cannot be parked");
    result = { parked: true };
    setTimeout(() => process.emit("SIGTERM"), 200);
  } else if (req.type === "permission") {
    const perm = permissions.get(req.requestId);
    if (!perm) throw new Error("Permission is no longer pending");
    if (perm.questions) {
      const answers = validateQuestionAnswers(perm.questions, req.answers);
      if (perm.method === "mcpServer/elicitation/request")
        child!.stdin.write(
          JSON.stringify({
            id: perm.id,
            result: mcpAnswer(perm.input, perm.questions, answers),
          }) + "\n",
        );
      else if (perm.method === "cursor/question")
        cursor!.answer(req.requestId, answers);
      else if (perm.method === "claude/question")
        perm.resolve!({
          behavior: "allow",
          updatedInput: claudeQuestionInput(
            perm.input,
            perm.questions,
            answers,
          ),
        });
      else
        child!.stdin.write(
          JSON.stringify({ id: perm.id, result: { answers } }) + "\n",
        );
    } else if (perm.method === "cursor/tool") {
      cursor!.permission(req.requestId, req.decision);
    } else if (perm.resolve) {
      perm.resolve(
        req.decision === "accept"
          ? { behavior: "allow", updatedInput: perm.input }
          : { behavior: "deny", message: "User denied this request" },
      );
    } else {
      if (
        ![
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
        ].includes(perm.method)
      )
        throw new Error(
          "This permission type requires a supported typed response",
        );
      child!.stdin.write(
        JSON.stringify({ id: perm.id, result: { decision: req.decision } }) +
          "\n",
      );
    }
    permissions.delete(req.requestId);
    emit("permission.answered", { id: req.requestId, decision: req.decision });
    result = { answered: true };
    state = permissions.size ? "waiting_permission" : "running";
    identity();
  } else throw new Error("Unsupported runner operation");
  const receipt = { state: "accepted", result };
  emit("command.accepted", { id: req.id, ...receipt });
  commands.set(req.id, receipt);
  return receipt;
}
const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 1024 * 1024) {
      socket.destroy();
      return;
    }
    let n;
    while ((n = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      void (async () => {
        try {
          const req = JSON.parse(line);
          socket.write(
            JSON.stringify({ ok: true, result: await handle(req) }) + "\n",
          );
        } catch (e) {
          socket.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
        }
      })();
    }
  });
});
server.listen(config.socket, () => {
  fs.chmodSync(config.socket, 0o600);
  identity();
  void init().catch((e) => {
    state = "failed";
    emit("runner.failed", { message: String(e) });
    identity();
  });
});
process.on("SIGTERM", async () => {
  if (state === "running" || state === "waiting_permission") {
    emit("runner.stopRefused", { reason: "Active provider work" });
    return;
  }
  child?.kill("SIGTERM");
  await cursor?.close();
  server.close();
  fs.closeSync(journal);
  process.exit(0);
});
