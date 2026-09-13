import type { Store } from "./store.ts";
import fs from "node:fs";
import path from "node:path";
import { alive } from "./home.ts";
const actor = { kind: "supervisor" as const, id: "heartbeat" };
const iso = (time: number) => new Date(time).toISOString();
export function heartbeatStatus(store: Store, time = Date.now()) {
  const state = store.setting("heartbeat") ?? {
    enabled: true,
    intervalMinutes: 10,
  };
  const supervisor = store
    .conversations(actor)
    .find((c) => c.role === "supervisor" && !c.retiredAt);
  const wake = state.pendingWakeId
    ? (store.db
        .prepare("SELECT state,data FROM wakes WHERE id=?")
        .get(state.pendingWakeId) as any)
    : undefined;
  const exhausted =
    wake &&
    ["pending", "presented"].includes(wake.state) &&
    (JSON.parse(wake.data).presentations ?? 0) >= 3 &&
    (!JSON.parse(wake.data).nextAt ||
      Date.parse(JSON.parse(wake.data).nextAt) <= time);
  const overdue =
    state.enabled &&
    state.nextCheckAt &&
    time - Date.parse(state.nextCheckAt) > 60000;
  const issues = [
    ...(state.issues ?? []),
    ...(exhausted ||
    (state.lastExhaustedAt &&
      (!state.lastAckAt ||
        Date.parse(state.lastAckAt) <= Date.parse(state.lastExhaustedAt)))
      ? [
          {
            code: "heartbeat_exhausted",
            message:
              "Heartbeat was presented three times without acknowledgement. Inspect Firstmate. The missed acknowledgement remains recorded; later fleet reviews continue.",
          },
        ]
      : []),
    ...(overdue
      ? [
          {
            code: "heartbeat_overdue",
            message: "The scheduled fleet check is overdue.",
          },
        ]
      : []),
  ];
  const status =
    !state.lastTickAt || time - Date.parse(state.lastTickAt) > 60000
      ? "stale"
      : !state.enabled
        ? "disabled"
        : store.setting("policy")?.paused
          ? "paused"
          : issues.length
            ? "attention"
            : !supervisor || supervisor.inputOwner !== "automation"
              ? "waiting"
              : supervisor.state !== "idle"
                ? "busy"
                : "healthy";
  return {
    ...state,
    status,
    summary: state.summary ?? "Waiting for the first fleet check",
    issues,
    capabilities: [
      {
        id: "native_supervision",
        status: "supported",
        description:
          "Persistent native supervision, 15-second external observations, five-minute health checks and retained PR state observations, and interval fleet reviews.",
      },
      {
        id: "legacy_check_hooks",
        status: "missing",
        description:
          "Legacy per-task shell check hooks are not executed. Native validation and GitHub checks are supported.",
      },
      {
        id: "legacy_live_state",
        status: "partial",
        description:
          "Retained worker status is observed without adopting or controlling its endpoint; authoritative legacy backend probing and recovery are not implemented.",
      },
      {
        id: "secondmates",
        status: "missing",
        description:
          "Persistent secondmate registration, scope routing, and automatic respawn are not implemented.",
      },
      {
        id: "project_modes",
        status: "partial",
        description:
          "Registered projects route to isolated native worker, validation, and review checkouts; all legacy delivery modes and per-project check configuration are not yet equivalent.",
      },
    ],
  };
}
export function configureHeartbeat(
  store: Store,
  enabled: boolean,
  intervalMinutes: number,
  time = Date.now(),
) {
  const prior = store.setting("heartbeat") ?? {};
  if (!enabled && prior.pendingWakeId) {
    const wake = store.db
      .prepare("SELECT data FROM wakes WHERE id=?")
      .get(prior.pendingWakeId) as any;
    if (wake) {
      const data = JSON.parse(wake.data);
      if (data.commandId)
        store.db
          .prepare(
            "UPDATE outbox SET state='cancelled' WHERE command_id=? AND state='pending'",
          )
          .run(data.commandId);
      store.db
        .prepare(
          "UPDATE wakes SET state='cancelled' WHERE id=? AND state IN ('pending','presented')",
        )
        .run(prior.pendingWakeId);
    }
  }
  store.setting("heartbeat", {
    ...prior,
    enabled,
    intervalMinutes,
    nextCheckAt: iso(time + Math.min(5, intervalMinutes) * 60000),
    nextReviewAt: iso(time + intervalMinutes * 60000),
    ...(!enabled ? { pendingWakeId: null, reportedIssues: null } : {}),
  });
}
export function acknowledgeHeartbeat(
  store: Store,
  wakeId: string,
  time = Date.now(),
) {
  const state = store.setting("heartbeat");
  if (state?.pendingWakeId === wakeId)
    store.setting("heartbeat", {
      ...state,
      pendingWakeId: null,
      lastAckAt: iso(time),
    });
}
// Runs inside the runtime's ownership fence. Due time and wake insertion commit together.
export function checkHeartbeat(store: Store, time = Date.now()) {
  store.assertOwner();
  store.db.transaction(() => {
    const prior = store.setting("heartbeat") ?? {
      enabled: true,
      intervalMinutes: 10,
      nextCheckAt: iso(time),
    };
    if (!prior.enabled || Date.parse(prior.nextCheckAt) > time) {
      if (!store.setting("heartbeat")) store.setting("heartbeat", prior);
      return;
    }
    const tickets = store
      .tickets(actor)
      .filter((t) => !["completed", "cancelled"].includes(t.status));
    const managed = tickets.filter((t) => !store.externallyManaged(t.id));
    const external = tickets.length - managed.length;
    const ids = new Set(managed.map((t) => t.id));
    const conversations = store
      .conversations(actor)
      .filter(
        (c) =>
          !c.retiredAt &&
          (c.role === "supervisor" || (c.ticketId && ids.has(c.ticketId))),
      );
    const issues: Array<{ code: string; message: string }> = [];
    if (
      conversations.some(
        (c) =>
          c.role === "supervisor" &&
          c.runnerId &&
          store.setting("standing-orders:" + c.id)?.incarnation !==
            c.incarnation,
      )
    )
      issues.push({
        code: "context_refresh_required",
        message:
          "Firstmate is running with older startup context. Park and resume the same chat to load current standing orders.",
      });
    if (
      conversations.some(
        (c) =>
          c.role === "supervisor" &&
          store
            .setting("standing-orders:" + c.id)
            ?.warnings?.some(
              (w: { reason: string }) => !w.reason.startsWith("ABSENT:"),
            ),
      )
    )
      issues.push({
        code: "standing_orders_omitted",
        message:
          "Some standing-order files were unavailable or exceeded the safe context limit. Inspect the session context records.",
      });
    if (
      conversations.some(
        (c) => c.state === "planned" && store.hasFailedInitialLaunch(c.id),
      )
    )
      issues.push({
        code: "initial_launch_failed",
        message:
          "A worker has not started after a failed allocation. Bounded launch reconciliation checks the original lease and preserves queued input; use Recover launch if automatic recovery stops.",
      });
    let missing = 0,
      quiet = 0,
      lease = 0;
    for (const c of conversations) {
      if (!c.runnerId || ["planned", "parked"].includes(c.state)) continue;
      try {
        store.assertLeaseActive(c.id);
        if (!fs.existsSync(c.cwd)) lease++;
      } catch {
        lease++;
      }
      const root = path.join(store.home, "app", "runners", c.runnerId);
      try {
        const identity = JSON.parse(
          fs.readFileSync(path.join(root, "identity.json"), "utf8"),
        );
        if (
          identity.incarnation !== c.incarnation ||
          !alive(identity.pid, identity.startIdentity)
        )
          missing++;
        else if (c.state === "running") {
          const age =
            time - fs.statSync(path.join(root, "events.jsonl")).mtimeMs;
          if (age > Math.max(1800000, prior.intervalMinutes * 180000)) quiet++;
        }
      } catch {
        missing++;
      }
    }
    if (missing)
      issues.push({
        code: "runner_unverified",
        message: `${missing} runner identities need reconciliation.`,
      });
    if (lease)
      issues.push({
        code: "lease_unavailable",
        message: `${lease} conversation leases or working directories need reconciliation.`,
      });
    if (quiet)
      issues.push({
        code: "worker_quiet",
        message: `${quiet} running sessions have no recent events; long tools may still be working. Check progress before intervening.`,
      });
    const targets = new Set(conversations.map((c) => c.id));
    let uncertain = 0,
      old = 0;
    for (const job of store.db
      .prepare(
        "SELECT target_id,state,created_at FROM outbox WHERE state IN ('pending','dispatching','uncertain')",
      )
      .all() as any[]) {
      if (!targets.has(job.target_id) && !ids.has(job.target_id)) continue;
      if (job.state === "uncertain") uncertain++;
      else if (time - Date.parse(job.created_at) > 600000) old++;
    }
    const prErrors = tickets.filter((t) =>
      store.setting("external-pr-error:" + t.id),
    );
    if (prErrors.length)
      issues.push({
        code: "external_pr_observation",
        message: `${prErrors.length} retained PR observations failed; inspect authentication or network access.`,
      });
    const recovery = conversations.filter(
      (c) => c.role === "supervisor" && ["lost", "failed"].includes(c.state),
    );
    if (recovery.length)
      issues.push({
        code: "supervisor_recovery",
        message:
          "Firstmate requires verified exact-session recovery. Automatic recovery is bounded and waits for dead processes and reconciled effects.",
      });
    if (uncertain)
      issues.push({
        code: "uncertain_dispatch",
        message: `${uncertain} dispatches need reconciliation before retry.`,
      });
    if (old)
      issues.push({
        code: "delayed_dispatch",
        message: `${old} dispatches have waited over ten minutes.`,
      });
    if (
      external &&
      store.setting("legacyExternalChanges")?.requiresReconciliation
    )
      issues.push({
        code: "external_observation",
        message:
          "Retained external worker observations changed; inspect them without adopting or controlling those workers.",
      });
    const summary = `${managed.length} active managed tickets; ${external} retained external tickets; ${issues.length} health concerns.`;
    const state = {
      ...prior,
      lastCheckAt: iso(time),
      nextCheckAt: iso(time + Math.min(5, prior.intervalMinutes) * 60000),
      summary,
      issues,
    };
    const existing = prior.pendingWakeId
      ? (store.db
          .prepare("SELECT state,data FROM wakes WHERE id=?")
          .get(prior.pendingWakeId) as any)
      : undefined;
    if (existing && ["pending", "presented"].includes(existing.state)) {
      const delivery = JSON.parse(existing.data);
      if (
        (delivery.presentations ?? 0) >= 3 &&
        delivery.nextAt &&
        Date.parse(delivery.nextAt) <= time
      ) {
        store.db
          .prepare("UPDATE wakes SET state='exhausted' WHERE id=?")
          .run(prior.pendingWakeId);
        state.pendingWakeId = null;
        state.lastExhaustedAt = iso(time);
        store.event("heartbeat.exhausted", "heartbeat", {
          wakeId: prior.pendingWakeId,
        });
      }
    }
    if (
      !existing ||
      ["handled", "cancelled", "exhausted"].includes(existing.state)
    )
      state.pendingWakeId = null;
    if (!issues.length) state.reportedIssues = null;
    const fingerprint = JSON.stringify(issues);
    const reviewDue =
      !prior.nextReviewAt || Date.parse(prior.nextReviewAt) <= time;
    if (reviewDue)
      state.nextReviewAt = iso(time + prior.intervalMinutes * 60000);
    // Idle unchanged fleets incur no model turn; active work gets an interval status review.
    if (
      !state.pendingWakeId &&
      ((reviewDue && tickets.length > 0) ||
        (issues.length > 0 && fingerprint !== prior.reportedIssues))
    ) {
      const id = "heartbeat:" + time;
      store.db.prepare("INSERT OR IGNORE INTO wakes VALUES(?,?,?,?,?)").run(
        id,
        null,
        "pending",
        JSON.stringify({
          kind: "heartbeat",
          summary,
          issues,
          createdAt: iso(time),
        }),
        iso(time),
      );
      state.pendingWakeId = id;
      state.lastWakeAt = iso(time);
      state.reportedIssues = fingerprint;
    }
    store.setting("heartbeat", state);
    store.event("heartbeat.checked", "heartbeat", { checkedAt: iso(time) });
  })();
}
export function heartbeatCompleted(store: Store, time = Date.now()) {
  const state = store.setting("heartbeat") ?? {
    enabled: true,
    intervalMinutes: 10,
    nextCheckAt: iso(time),
  };
  if (!state.lastTickAt || time - Date.parse(state.lastTickAt) >= 15000)
    store.setting("heartbeat", { ...state, lastTickAt: iso(time) });
}
