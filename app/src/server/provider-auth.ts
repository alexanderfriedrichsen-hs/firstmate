import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type AuthProvider = "claude" | "cursor";
type Login = {
  state: "idle" | "pending" | "succeeded" | "failed" | "cancelled";
  startedAt?: string;
};
export type ProviderAuthStatus = {
  provider: AuthProvider;
  installed: boolean;
  authenticated: boolean | null;
  message: string;
  login: Login;
};
type RunResult = { code: number | null; output: string };
export function providerExecutable(provider: AuthProvider) {
  const names = provider === "claude" ? ["claude"] : ["cursor-agent", "agent"];
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local/bin"),
  ];
  for (const name of names)
    for (const dir of dirs.filter(Boolean)) {
      const file = path.resolve(dir, name);
      try {
        if (fs.statSync(file).isFile()) {
          fs.accessSync(file, fs.constants.X_OK);
          return file;
        }
      } catch {}
    }
  return undefined;
}
export function subscriptionEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CURSOR_API_KEY|CURSOR_AUTH_TOKEN|OPENAI_API_KEY)/.test(
        key,
      )
    )
      delete env[key];
  return env;
}
// Native CLIs own OAuth and credential storage. Never persist or return their raw output.
export class ProviderAuth {
  private logins = new Map<AuthProvider, Login>();
  private statusCache = new Map<
    AuthProvider,
    { at: number; value: ProviderAuthStatus }
  >();
  private pendingStatus = new Map<AuthProvider, Promise<ProviderAuthStatus>>();
  private children = new Map<AuthProvider, ChildProcess>();
  constructor(
    private resolve = providerExecutable,
    private launch: typeof spawn = spawn,
  ) {}
  private run(file: string, args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = this.launch(file, args, {
        cwd: os.homedir(),
        env: subscriptionEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-32768);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ code: null, output: "" });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }
  async status(provider: AuthProvider): Promise<ProviderAuthStatus> {
    const cached = this.statusCache.get(provider);
    if (cached && Date.now() - cached.at < 2000)
      return {
        ...cached.value,
        login: { ...(this.logins.get(provider) ?? cached.value.login) },
      };
    const pending = this.pendingStatus.get(provider);
    if (pending) return pending;
    const work = this.readStatus(provider)
      .then((value) => {
        this.statusCache.set(provider, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.pendingStatus.delete(provider));
    this.pendingStatus.set(provider, work);
    return work;
  }
  private async readStatus(
    provider: AuthProvider,
  ): Promise<ProviderAuthStatus> {
    const file = this.resolve(provider);
    const login = {
      ...(this.logins.get(provider) ?? { state: "idle" as const }),
    };
    if (!file)
      return {
        provider,
        installed: false,
        authenticated: false,
        login,
        message: `Install ${provider === "claude" ? "Claude Code" : "Cursor CLI"} to sign in.`,
      };
    const result = await this.run(
      file,
      provider === "claude"
        ? ["auth", "status", "--json"]
        : ["status", "--format", "json"],
    );
    let authenticated: boolean | null = null;
    if (provider === "claude") {
      try {
        const value = JSON.parse(result.output);
        if (typeof value.loggedIn === "boolean")
          authenticated = value.loggedIn && value.authMethod === "claude.ai";
      } catch {}
    } else {
      try {
        const value = JSON.parse(result.output);
        if (typeof value.isAuthenticated === "boolean")
          authenticated = value.isAuthenticated;
      } catch {}
    }
    return {
      provider,
      installed: true,
      authenticated,
      login,
      message:
        login.state === "pending"
          ? "Complete sign-in in your browser. Credentials stay with the provider CLI."
          : authenticated === true
            ? "Signed in through the provider CLI."
            : authenticated === false
              ? "Sign in with your provider account."
              : "Could not verify sign-in. Retry the status check.",
    };
  }
  async list() {
    return {
      providers: await Promise.all(
        (["claude", "cursor"] as const).map((p) => this.status(p)),
      ),
    };
  }
  async login(provider: AuthProvider) {
    if (this.children.has(provider)) return this.status(provider);
    const file = this.resolve(provider);
    if (!file) return this.status(provider);
    const login: Login = {
      state: "pending",
      startedAt: new Date().toISOString(),
    };
    this.logins.set(provider, login);
    const child = this.launch(
      file,
      provider === "claude" ? ["auth", "login", "--claudeai"] : ["login"],
      { cwd: os.homedir(), env: subscriptionEnv(), stdio: "ignore" },
    );
    this.children.set(provider, child);
    const timer = setTimeout(() => {
      login.state = "failed";
      child.kill("SIGKILL");
    }, 300000);
    const finish = (success: boolean) => {
      clearTimeout(timer);
      this.statusCache.delete(provider);
      if (login.state === "pending")
        login.state = success ? "succeeded" : "failed";
      if (this.children.get(provider) === child) this.children.delete(provider);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    return this.status(provider);
  }
  async cancel(provider: AuthProvider) {
    const child = this.children.get(provider);
    if (child) {
      this.logins.get(provider)!.state = "cancelled";
      child.kill("SIGKILL");
    }
    return this.status(provider);
  }
  close() {
    for (const [provider, child] of this.children) {
      this.logins.get(provider)!.state = "cancelled";
      child.kill("SIGKILL");
    }
  }
}
