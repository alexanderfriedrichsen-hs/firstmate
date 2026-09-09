import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Store } from "./store.ts";
import { alive } from "./home.ts";
import { git } from "./revisions.ts";

export type RetirementRequest = {
  kind: "conversation" | "check";
  targetId: string;
  landedRef?: string;
  scratch?: { artifactId: string; reason: string };
};
export type LeaseCommand = (args: string[], cwd: string) => string;
const command: LeaseCommand = (args, cwd) =>
  execFileSync("treehouse", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });

/** Inspect only. A report is a fingerprint of current evidence, never permission to discard changes. */
export function prepareLeaseRetirement(
  store: Store,
  request: RetirementRequest,
  run: LeaseCommand = command,
) {
  const blockers: string[] = [];
  if (store.setting("policy")?.paused !== true)
    blockers.push("Pause automatic dispatch before retiring leases");
  const project = store.setting("project");
  if (!project?.source || !project?.remote)
    throw new Error("Configure an explicit project before retiring leases");
  const c =
    request.kind === "conversation"
      ? store
          .conversations({ kind: "user", id: "lease-retirement" })
          .find((c) => c.id === request.targetId)
      : undefined;
  const job =
    request.kind === "check"
      ? store.setting("check:" + request.targetId)
      : undefined;
  if (!c && !job) throw new Error("Unknown lease target");
  const lease = c ? store.setting("lease:" + c.id) : job.lease;
  if (!lease?.path || !lease.lease_id || !lease.lease_holder)
    throw new Error("Recorded lease identity is incomplete");
  const cwd = fs.realpathSync(lease.path);
  if (cwd !== fs.realpathSync(c?.cwd ?? job.cwd))
    throw new Error("Recorded lease path differs from target");
  const pool = JSON.parse(run(["status", "--json"], project.source));
  const current = pool.find((entry: any) => entry.path === cwd);
  if (
    !current ||
    current.status !== "leased" ||
    current.lease_id !== lease.lease_id ||
    current.lease_holder !== lease.lease_holder
  )
    blockers.push("Treehouse lease identity changed");
  if (current?.processes?.length)
    blockers.push("Processes still use this checkout");
  const remote = git(cwd, ["remote", "get-url", "origin"]);
  if (remote !== project.remote || (lease.remote && remote !== lease.remote))
    blockers.push("Repository identity changed");
  // Include ignored files: treehouse return can clean those too.
  const dirty = git(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignored",
  ]);
  if (dirty)
    blockers.push(
      "Checkout contains tracked, untracked, or ignored changes; preserve them first",
    );
  const head = git(cwd, ["rev-parse", "HEAD"]);
  for (const entry of store
    .conversations({ kind: "user", id: "lease-retirement" })
    .filter((entry) => path.resolve(entry.cwd) === cwd)) {
    if (!["parked", "lost", "failed"].includes(entry.state))
      blockers.push("Conversation must be parked and settled");
    if (
      store.db
        .prepare(
          "SELECT 1 FROM outbox WHERE target_id=? AND state IN ('pending','dispatching','uncertain')",
        )
        .get(entry.id)
    )
      blockers.push("Conversation has unresolved dispatch");
    if (entry.providerId && !entry.runnerId)
      blockers.push("Provider identity has no runner provenance");
    if (entry.runnerId) {
      try {
        const identity = JSON.parse(
          fs.readFileSync(
            path.join(
              store.home,
              "app",
              "runners",
              entry.runnerId,
              "identity.json",
            ),
            "utf8",
          ),
        );
        if (
          !Number.isInteger(identity.pid) ||
          identity.pid < 2 ||
          typeof identity.startIdentity !== "string" ||
          !identity.startIdentity.trim() ||
          (identity.providerPid !== undefined &&
            (!Number.isInteger(identity.providerPid) ||
              identity.providerPid < 2 ||
              typeof identity.providerStartIdentity !== "string" ||
              !identity.providerStartIdentity.trim()))
        )
          blockers.push("Runner or provider identity is malformed");
        if (
          alive(identity.pid, identity.startIdentity) ||
          (identity.providerPid &&
            alive(identity.providerPid, identity.providerStartIdentity))
        )
          blockers.push("Runner or provider is alive");
      } catch {
        blockers.push("Runner identity is unavailable");
      }
    }
  }
  if (job) {
    if (!["passed", "failed"].includes(job.state))
      blockers.push("Check job has not settled");
    try {
      const identity = JSON.parse(
        fs.readFileSync(
          path.join(store.home, "app", "checks", job.id, "identity.json"),
          "utf8",
        ),
      );
      if (
        !Number.isInteger(identity.pid) ||
        identity.pid < 2 ||
        typeof identity.startIdentity !== "string" ||
        !identity.startIdentity.trim()
      )
        blockers.push("Check runner identity is malformed");
      if (alive(identity.pid, identity.startIdentity))
        blockers.push("Check runner is alive");
    } catch {
      blockers.push("Check runner identity is unavailable");
    }
  }
  let landedHead: string | null = null;
  let preservedArtifact: string | null = null;
  if (request.landedRef && !request.scratch) {
    // Only remote-tracking refs are acceptable; no caller-created local branch proves landing.
    if (!/^refs\/remotes\/[^/]+\/.+/.test(request.landedRef))
      blockers.push("Landing requires an explicit remote-tracking ref");
    else
      try {
        landedHead = git(cwd, [
          "rev-parse",
          "--verify",
          request.landedRef + "^{commit}",
        ]);
        git(cwd, ["merge-base", "--is-ancestor", head, landedHead]);
      } catch {
        blockers.push(
          "HEAD is not landed in the specified remote-tracking ref",
        );
      }
  } else if (request.scratch && !request.landedRef) {
    const artifact = store.db
      .prepare("SELECT id FROM artifacts WHERE id=?")
      .get(request.scratch.artifactId);
    let artifactIntact = false;
    if (artifact && /^[a-f0-9]{64}$/.test(request.scratch.artifactId)) {
      try {
        artifactIntact =
          createHash("sha256")
            .update(
              fs.readFileSync(
                path.join(
                  store.home,
                  "app",
                  "objects",
                  request.scratch.artifactId,
                ),
              ),
            )
            .digest("hex") === request.scratch.artifactId;
      } catch {}
    }
    const revision =
      job?.revisionFacts ??
      (c?.stage === "review"
        ? store.setting("revision:" + c.reviewRevision)
        : undefined);
    const scoped = job
      ? job.artifactId === request.scratch.artifactId
      : store.db
          .prepare(
            "SELECT 1 FROM artifact_access WHERE artifact_id=? AND conversation_id=?",
          )
          .get(request.scratch.artifactId, c!.id);
    if (
      !request.scratch.reason.trim() ||
      !artifactIntact ||
      !scoped ||
      !revision ||
      revision.head !== head
    )
      blockers.push(
        "Scratch retirement requires preserved check or review evidence and an unchanged source revision",
      );
    else preservedArtifact = request.scratch.artifactId;
  } else
    blockers.push(
      "Declare landed work or preserved scratch check/review evidence",
    );
  const facts = {
    schema: "firstmate.lease-retirement.v1",
    request,
    cwd,
    leaseId: lease.lease_id,
    leaseHolder: lease.lease_holder,
    head,
    remote,
    landedHead,
    preservedArtifact,
    blockers: [...new Set(blockers)],
  };
  return {
    ...facts,
    ready: blockers.length === 0,
    reportId: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  };
}

/** Recheck immediately, then use Treehouse's atomic identity guards. Never force-clean. */
export function executeLeaseRetirement(
  store: Store,
  request: RetirementRequest,
  approvedReportId: string,
  run: LeaseCommand = command,
) {
  store.assertOwner();
  const report = prepareLeaseRetirement(store, request, run);
  if (!report.ready || report.reportId !== approvedReportId)
    throw new Error("Lease retirement report is blocked or stale");
  store.setting(
    "lease-retirement-intent:" + request.kind + ":" + request.targetId,
    report,
  );
  run(
    [
      "return",
      report.cwd,
      "--if-lease-id",
      report.leaseId,
      "--if-lease-holder",
      report.leaseHolder,
    ],
    store.setting("project").source,
  );
  store.setting("retired-lease:" + request.kind + ":" + request.targetId, {
    ...report,
    retiredAt: new Date().toISOString(),
  });
  store.event("lease.retired", request.targetId, report);
  return report;
}
