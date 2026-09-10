import {
  normalizeQuestions,
  validateQuestionAnswers,
  fullAccessCursorArgs,
  type Question,
  type Answers,
} from "./questions.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { subscriptionEnv } from "./provider-auth.ts";
import { randomUUID } from "node:crypto";

// ACP v1 transport. Native tools retain their own execution and permission scope.
export class CursorACP {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  private approvals = new Map<
    string,
    { id: number | string; options: any[] }
  >();
  private questions = new Map<
    string,
    { id: number | string; method: string; questions: Question[] }
  >();
  private loading = false;
  private cancelGeneration = 0;
  sessionId?: string;
  sessionMetadata: any;
  constructor(
    executable: string,
    cwd: string,
    private emit: (type: string, payload: any) => void,
    child?: ChildProcessWithoutNullStreams,
    private fullAccess = true,
  ) {
    this.child =
      child ??
      spawn(executable, fullAccess ? fullAccessCursorArgs : ["acp"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: subscriptionEnv(),
      });
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 8 * 1024 * 1024) {
        this.fail("Cursor response exceeds size limit");
        this.close();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.emit("cursor.protocolError", {
            message: "Invalid ACP response",
          });
        }
      }
    });
    this.child.stdin.on("error", () => this.fail("Cursor input closed"));
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.fail("Cursor could not start"));
    this.child.on("exit", () => this.fail("Cursor exited"));
  }
  private fail(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.approvals.clear();
    this.questions.clear();
    this.emit("provider.exit", { message });
  }
  private write(value: any) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  }
  private receive(message: any) {
    if (
      ["cursor/ask_question", "cursor/create_plan"].includes(message.method) &&
      message.id !== undefined
    ) {
      const id = randomUUID();
      try {
        const params =
          message.method === "cursor/create_plan"
            ? {
                title: message.params?.name ?? "Plan",
                questions: [
                  {
                    id: "plan",
                    prompt: message.params?.plan,
                    options: [
                      { id: "approve", label: "Approve plan" },
                      { id: "revise", label: "Revise plan" },
                    ],
                  },
                ],
              }
            : message.params;
        const questions = normalizeQuestions("cursor", params);
        this.questions.set(id, {
          id: message.id,
          method: message.method,
          questions,
        });
        this.emit("permission.request", {
          id,
          kind: "question",
          method: message.method,
          questions,
          params: message.params,
        });
      } catch {
        this.write({
          id: message.id,
          error: { code: -32602, message: "Unsupported question format" },
        });
      }
      return;
    }
    if (
      message.method === "session/request_permission" &&
      message.id !== undefined
    ) {
      if (message.params?.sessionId !== this.sessionId) {
        this.write({
          id: message.id,
          result: { outcome: { outcome: "cancelled" } },
        });
        return;
      }
      if (this.fullAccess) {
        const option =
          (message.params.options ?? []).find(
            (o: any) => o.kind === "allow_always",
          ) ??
          (message.params.options ?? []).find(
            (o: any) => o.kind === "allow_once",
          );
        this.write({
          id: message.id,
          result: {
            outcome: option
              ? { outcome: "selected", optionId: option.optionId }
              : { outcome: "cancelled" },
          },
        });
        this.emit("permission.autoApproved", {
          method: message.method,
          granted: !!option,
        });
        return;
      }
      const id = randomUUID();
      this.approvals.set(id, {
        id: message.id,
        options: message.params.options ?? [],
      });
      this.emit("permission.request", {
        id,
        method: "cursor/tool",
        params: message.params,
      });
      return;
    }
    if (message.method === "session/update") {
      if (!this.loading && message.params?.sessionId === this.sessionId)
        this.emit("cursor.update", message.params.update);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.write({
        id: message.id,
        error: { code: -32601, message: "Client capability not supported" },
      });
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error
        ? pending.reject(
            new Error(message.error.message ?? "ACP request failed"),
          )
        : pending.resolve(message.result);
    }
  }
  request(method: string, params: any, timeout = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error("Cursor request timed out: " + method));
          }, timeout)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  async initialize(cwd: string, resume?: string) {
    const hello = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "firstmate", version: "0.1.0" },
    });
    if (hello.protocolVersion !== 1)
      throw new Error("Unsupported Cursor ACP protocol");
    await this.request("authenticate", { methodId: "cursor_login" });
    this.loading = true;
    try {
      if (resume) {
        if (!hello.agentCapabilities?.loadSession)
          throw new Error("Cursor does not support resuming this session");
        this.sessionId = resume;
        this.sessionMetadata = await this.request("session/load", {
          sessionId: resume,
          cwd,
          mcpServers: [],
        });
      } else {
        const session = await this.request("session/new", {
          cwd,
          mcpServers: [],
        });
        this.sessionMetadata = session;
        if (typeof session.sessionId !== "string" || !session.sessionId)
          throw new Error("Cursor returned no session identity");
        this.sessionId = session.sessionId;
      }
      const modes = this.sessionMetadata?.modes;
      const agentMode = modes?.availableModes?.find(
        (mode: any) => mode.id === "agent",
      );
      if (this.fullAccess && agentMode && modes.currentModeId !== agentMode.id)
        await this.request("session/set_mode", {
          sessionId: this.sessionId,
          modeId: agentMode.id,
        });
    } finally {
      this.loading = false;
    }
    return this.sessionId;
  }
  async prompt(text: string, model: string) {
    const generation = this.cancelGeneration;
    await this.request("session/set_model", {
      sessionId: this.sessionId,
      modelId: model,
    });
    if (generation !== this.cancelGeneration)
      return { stopReason: "cancelled" };
    return this.request(
      "session/prompt",
      { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
      0,
    );
  }
  answer(id: string, answers: Answers) {
    const request = this.questions.get(id);
    if (!request) throw Error("Question is no longer pending");
    const valid = validateQuestionAnswers(request.questions, answers);
    const outcome =
      request.method === "cursor/create_plan"
        ? {
            outcome:
              valid.plan.answers[0] === "Approve plan"
                ? "accepted"
                : "rejected",
          }
        : {
            outcome: "answered",
            answers: request.questions.map((q) => ({
              questionId: q.id,
              selectedOptionIds: valid[q.id].answers.map(
                (label) => q.options!.find((o) => o.label === label)!.nativeId,
              ),
            })),
          };
    this.write({ id: request.id, result: { outcome } });
    this.questions.delete(id);
  }
  permission(id: string, decision: string) {
    const request = this.approvals.get(id);
    if (!request) throw new Error("Permission is no longer pending");
    const option = request.options.find(
      (o) => o.kind === (decision === "accept" ? "allow_once" : "reject_once"),
    );
    if (decision === "accept" && !option)
      throw new Error("Cursor did not offer a one-time approval");
    this.write({
      id: request.id,
      result: {
        outcome: option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      },
    });
    this.approvals.delete(id);
  }
  cancel() {
    this.cancelGeneration++;
    for (const request of this.questions.values())
      this.write({
        id: request.id,
        result: { outcome: { outcome: "cancelled" } },
      });
    this.questions.clear();
    this.emit("permission.expired", {});
    for (const request of this.approvals.values())
      this.write({
        id: request.id,
        result: { outcome: { outcome: "cancelled" } },
      });
    this.approvals.clear();
    this.write({
      method: "session/cancel",
      params: { sessionId: this.sessionId },
    });
  }
  close(): Promise<void> {
    if (this.child.exitCode != null || this.child.signalCode != null)
      return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}
