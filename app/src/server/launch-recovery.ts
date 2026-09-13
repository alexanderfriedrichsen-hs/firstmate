import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Store } from "./store.ts";
import type { Conversation } from "../contracts.ts";
import { git } from "./revisions.ts";

export function assertUnlaunched(c: Conversation) {
  if (
    c.state !== "planned" ||
    c.incarnation !== 0 ||
    c.runnerId ||
    c.providerId ||
    !c.ticketId
  )
    throw new Error(
      "Launch reconciliation requires an unstarted worker with no native or runner identity",
    );
}
export function inspectLaunchLeases(source: string): any[] {
  const entries = JSON.parse(
    execFileSync("treehouse", ["status", "--json"], {
      cwd: source,
      encoding: "utf8",
      timeout: 60000,
    }),
  );
  if (!Array.isArray(entries)) throw new Error("Malformed Treehouse inventory");
  const roots = [
    source,
    ...entries.map((e: any) => path.dirname(path.dirname(String(e.path)))),
  ];
  const processes = execFileSync("ps", ["-axo", "pid=,comm=,args="], {
    encoding: "utf8",
    timeout: 10000,
  });
  for (const line of processes.split("\n")) {
    const [pid, executable, ...args] = line.trim().split(/\s+/);
    const name = path.basename(executable ?? "");
    if (name === "treehouse" && args.includes("get"))
      throw new Error(
        "A Treehouse allocator still runs; wait for it to settle",
      );
    if (!["git", "ssh"].includes(name)) continue;
    let cwd: string;
    try {
      cwd =
        execFileSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], {
          encoding: "utf8",
          timeout: 5000,
        })
          .split("\n")
          .find((l) => l.startsWith("n"))
          ?.slice(1) ?? "";
    } catch {
      throw new Error("Cannot verify an allocator subprocess has settled");
    }
    if (
      !cwd ||
      roots.some((root) => cwd === root || cwd.startsWith(root + path.sep))
    )
      throw new Error(
        "A Git or SSH subprocess still uses the allocation source or pool; wait for it to settle",
      );
  }
  return entries;
}
export function reconcileLaunch(
  store: Store,
  c: Conversation,
  inspect = inspectLaunchLeases,
) {
  store.assertOwner();
  assertUnlaunched(c);
  const original: any = store.db
    .prepare(
      "SELECT * FROM outbox WHERE target_id=? AND kind='conversation.launch' AND (state='uncertain' OR (state='dispatching' AND generation<>?))",
    )
    .get(c.id, store.generation);
  if (!original) throw new Error("No uncertain initial launch to reconcile");
  const project = store.projectForConversation(c);
  if (
    project.remote !==
    store.projectForTicket(
      store.ticket(c.ticketId!, { kind: "user", id: "launch-recovery" }),
    ).remote
  )
    throw new Error("Ticket project changed");
  const holder = "firstmate-attempt-" + c.id;
  const entries = inspect(project.source);
  if (!Array.isArray(entries)) throw new Error("Malformed Treehouse inventory");
  const matches = entries.filter((entry: any) => entry.lease_holder === holder);
  if (matches.length > 1)
    throw new Error("Multiple matching leases; reconcile allocation manually");
  const recorded = store.setting("lease:" + c.id);
  if (recorded && !matches.length)
    throw new Error("Recorded lease is absent; do not allocate again");
  if (matches.length) {
    const lease = matches[0];
    if (
      lease.status !== "leased" ||
      !lease.lease_id ||
      !Array.isArray(lease.processes) ||
      lease.processes.length ||
      (recorded &&
        (recorded.lease_id !== lease.lease_id || recorded.path !== lease.path))
    )
      throw new Error("Lease identity or processes are ambiguous");
    const root = fs.realpathSync(lease.path);
    if (
      root === fs.realpathSync(project.source) ||
      git(root, ["remote", "get-url", "origin"]) !== project.remote
    )
      throw new Error("Lease repository identity differs");
    store.setting("lease:" + c.id, {
      ...lease,
      path: root,
      source: project.source,
      remote: project.remote,
    });
  }
  // The runner identity is persisted before spawn. Incarnation zero therefore proves no native launch occurred.
  assertUnlaunched(
    store.conversation(c.id, { kind: "user", id: "launch-recovery" }),
  );
  store.db
    .prepare("UPDATE outbox SET state='pending',generation=NULL WHERE id=?")
    .run(original.id);
  store.event(
    "conversation.launchReconciled",
    c.id,
    {
      jobId: original.id,
      lease: matches.length ? "retained" : "not-acquired",
      nativeLaunch: "not-started",
    },
    c.ticketId,
  );
}
