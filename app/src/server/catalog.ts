import { CursorACP } from "./cursor-acp.ts";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { providerExecutable, subscriptionEnv } from "./provider-auth.ts";
import { createInterface } from "node:readline";

const cache = new Map<string, { at: number; value: any }>();
const pending = new Map<string, Promise<any>>();
// Metadata RPCs only: no thread, turn, credential export, or billing mutation.
export async function nativeCatalog(
  cwd: string,
  topic: "skills" | "models" | "account",
  provider = "codex",
) {
  const key = provider + ":" + topic + ":" + cwd;
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < 60000) return saved.value;
  if (pending.has(key)) return pending.get(key);
  const work = (
    provider === "claude" && topic === "models"
      ? claudeModels(cwd)
      : provider === "cursor" && topic === "models"
        ? cursorModels(cwd)
        : provider === "codex"
          ? readCatalog(cwd, topic)
          : Promise.reject(Error("Provider catalog is unavailable"))
  )
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
async function readCatalog(cwd: string, topic: string) {
  const executable = providerExecutable("codex");
  if (!executable) throw Error("Install Codex CLI to load its catalog.");
  const child = spawn(executable, ["app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, OPENAI_API_KEY: undefined },
  });
  const calls = new Map<
    number,
    { resolve: Function; reject: Function; timer: NodeJS.Timeout }
  >();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const m = JSON.parse(line);
      const call = calls.get(m.id);
      if (call) {
        clearTimeout(call.timer);
        calls.delete(m.id);
        m.error ? call.reject(Error(m.error.message)) : call.resolve(m.result);
      }
    } catch {}
  });
  const fail = () => {
    for (const call of calls.values()) {
      clearTimeout(call.timer);
      call.reject(Error("Codex metadata connection closed"));
    }
    calls.clear();
  };
  child.stdin.on("error", fail);
  child.on("error", fail);
  child.on("exit", fail);
  const rpc = (method: string, params: any = {}) =>
    new Promise<any>((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        calls.delete(key);
        reject(Error("Provider metadata timed out"));
      }, 15000);
      calls.set(key, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: key, method, params }) + "\n");
    });
  try {
    await rpc("initialize", {
      clientInfo: { name: "firstmate_catalog", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    if (topic === "skills")
      return {
        ...(await rpc("skills/list", { cwds: [cwd], forceReload: true })),
        observedAt: new Date().toISOString(),
      };
    if (topic === "models") {
      const data: any[] = [];
      let cursor: string | null = null;
      do {
        const page = await rpc("model/list", { limit: 100, cursor });
        data.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor && data.length < 1000);
      return { data, observedAt: new Date().toISOString() };
    }
    const [limits, usage] = await Promise.allSettled([
      rpc("account/rateLimits/read"),
      rpc("account/usage/read"),
    ]);
    const rate = limits.status === "fulfilled" ? limits.value : null;
    return {
      provider: "codex",
      observedAt: new Date().toISOString(),
      limits: rate
        ? {
            rateLimits: rate.rateLimits,
            rateLimitsByLimitId: rate.rateLimitsByLimitId,
          }
        : null,
      usage: usage.status === "fulfilled" ? usage.value : null,
      limitsError: limits.status === "rejected" ? String(limits.reason) : null,
      usageError: usage.status === "rejected" ? String(usage.reason) : null,
      subscriptionSpend: null,
      subscriptionSpendReason:
        "Provider metadata does not expose subscription invoices. Token cost estimates are not subscription charges.",
    };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
    fail();
  }
}

async function claudeModels(cwd: string) {
  const executable = providerExecutable("claude");
  if (!executable) throw Error("Install Claude Code to load models.");
  const controller = new AbortController();
  const client = query({
    prompt: (async function* () {})(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: executable,
      abortController: controller,
      settingSources: [],
      env: subscriptionEnv(),
    },
  });
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const models = await client.supportedModels();
    return {
      data: models.map((m) => {
        const levels = m.supportedEffortLevels ?? [];
        return {
          model: m.value,
          displayName: m.displayName,
          description: m.description,
          defaultReasoningEffort: levels.includes("high")
            ? "high"
            : (levels[0] ?? ""),
          supportedReasoningEfforts: levels.map((reasoningEffort) => ({
            reasoningEffort,
            description: reasoningEffort,
          })),
        };
      }),
      observedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    client.close();
  }
}

export function normalizeCursorModels(models: any[]) {
  return models
    .filter(
      (m) =>
        typeof m.modelId === "string" &&
        m.modelId.length &&
        typeof m.name === "string",
    )
    .map((m) => ({
      model: m.modelId,
      displayName: m.name,
      description: m.description,
      defaultReasoningEffort: "",
      supportedReasoningEfforts: [],
    }));
}
async function cursorModels(cwd: string) {
  const executable = providerExecutable("cursor");
  if (!executable) throw Error("Install Cursor CLI to load models.");
  const client = new CursorACP(executable, cwd, () => {});
  const timer = setTimeout(() => client.close(), 15000);
  try {
    await client.initialize(cwd);
    const data = normalizeCursorModels(
      client.sessionMetadata?.models?.availableModels ?? [],
    );
    if (!data.length)
      throw Error("Cursor did not return a supported model catalog.");
    return {
      data,
      observedAt: new Date().toISOString(),
      effortReason:
        "Choose a model variant with the thinking effort you want. Cursor includes effort in each native model ID.",
    };
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
