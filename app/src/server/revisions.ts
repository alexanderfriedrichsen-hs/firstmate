import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
export type Revision = {
  repository: string;
  head: string;
  base: string;
  mergeBase: string;
  tree: string;
  checkConfig: string;
  requirementPlan: string;
};
export function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
  }).trim();
}
export function captureRevision(
  cwd: string,
  config: unknown,
  plan: string[],
  base = "origin/main",
): Revision {
  if (git(cwd, ["status", "--porcelain"]))
    throw new Error(
      "Commit or park local changes before collecting revision evidence",
    );
  return {
    repository: git(cwd, ["remote", "get-url", "origin"]),
    head: git(cwd, ["rev-parse", "HEAD"]),
    base: git(cwd, ["rev-parse", base]),
    mergeBase: git(cwd, ["merge-base", "HEAD", base]),
    tree: git(cwd, ["rev-parse", "HEAD^{tree}"]),
    checkConfig: hash(config),
    requirementPlan: hash(plan),
  };
}
export function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function fingerprint(revision: Revision) {
  return hash(revision);
}
export const transientClasses = new Set([
  "rate_limit",
  "transport_before_acceptance",
  "service_unavailable",
]);
export function retryDecision(input: {
  errorClass: string;
  ordinal: number;
  elapsedMs: number;
  allowance: boolean;
  writerAlive: boolean;
  uncertain: boolean;
  retryAfterMs?: number;
  random?: number;
}) {
  if (input.uncertain || input.writerAlive || !input.allowance)
    return {
      eligible: false,
      reason: "Unsettled effect, active writer, or unavailable allowance",
    };
  if (!transientClasses.has(input.errorClass))
    return { eligible: false, reason: "Failure is not classified transient" };
  if (input.ordinal >= 3 || input.elapsedMs >= 3600000)
    return {
      eligible: false,
      reason: "Automatic attempt or elapsed-time budget exhausted",
    };
  const backoff = [30000, 120000][Math.max(0, input.ordinal - 1)];
  return {
    eligible: true,
    delayMs: Math.max(
      input.retryAfterMs ?? 0,
      Math.round(backoff * (0.9 + (input.random ?? Math.random()) * 0.2)),
    ),
  };
}
