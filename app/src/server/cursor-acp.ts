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
  private loading = false;
  private cancelGeneration = 0;
  sessionId?: string;
  sessionMetadata: any;
  constructor(
    executable: string,
    cwd: string,
    private emit: (type: string, payload: any) => void,
    child?: ChildProcessWithoutNullStreams,
  ) {
    this.child =
      child ??
      spawn(executable, ["acp"], {
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
    this.emit("provider.exit", { message });
  }
  private write(value: any) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
  }
  private receive(message: any) {
    if (message.method === "cursor/ask_question" && message.id !== undefined) {
      this.write({
        id: message.id,
        result: { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    if (message.method === "cursor/create_plan" && message.id !== undefined) {
      this.write({
        id: message.id,
        result: {
          outcome: {
            outcome: "rejected",
            reason: "Plan approval is unavailable; ask the user in chat.",
          },
        },
      });
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
        await this.request("session/load", {
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
