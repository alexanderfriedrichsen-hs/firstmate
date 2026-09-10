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
    ...(exhausted
      ? [
          {
            code: "heartbeat_exhausted",
            message:
              "Heartbeat was presented three times without acknowledgement. Inspect Firstmate, then disable and re-enable heartbeat to retry.",
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
    nextCheckAt: iso(time + intervalMinutes * 60000),
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
      nextCheckAt: iso(time + prior.intervalMinutes * 60000),
      summary,
      issues,
    };
    const existing = prior.pendingWakeId
      ? (store.db
          .prepare("SELECT state FROM wakes WHERE id=?")
          .get(prior.pendingWakeId) as any)
      : undefined;
    if (!existing || ["handled", "cancelled"].includes(existing.state))
      state.pendingWakeId = null;
    if (!issues.length) state.reportedIssues = null;
    const fingerprint = JSON.stringify(issues);
    // Idle unchanged fleets incur no model turn; active work gets an interval status review.
    if (
      !state.pendingWakeId &&
      (managed.length > 0 ||
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
