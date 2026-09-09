import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const cache = new Map<string, { at: number; value: any }>();
const pending = new Map<string, Promise<any>>();
// Metadata RPCs only: no thread, turn, credential export, or billing mutation.
export async function nativeCatalog(
  cwd: string,
  topic: "skills" | "models" | "account",
) {
  const key = topic + ":" + cwd;
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < 60000) return saved.value;
  if (pending.has(key)) return pending.get(key);
  const work = readCatalog(cwd, topic)
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
async function readCatalog(cwd: string, topic: string) {
  const child = spawn("codex", ["app-server"], {
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
