import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Store } from "./store.ts";
import type { Conversation } from "../contracts.ts";
import { git } from "./revisions.ts";

const execFileAsync = promisify(execFile);
const INSPECT_DEADLINE_MS = 30000;
const LSOF_CONCURRENCY = 4;

export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
}
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
export async function inspectLaunchLeases(source: string): Promise<any[]> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), INSPECT_DEADLINE_MS);
  try {
    const status = await execFileAsync("treehouse", ["status", "--json"], {
      cwd: source,
      encoding: "utf8",
      timeout: 60000,
      signal: controller.signal,
    });
    const entries = JSON.parse(status.stdout);
    if (!Array.isArray(entries))
      throw new Error("Malformed Treehouse inventory");
    const roots = [
      source,
      ...entries.map((e: any) => path.dirname(path.dirname(String(e.path)))),
    ];
    const ps = await execFileAsync("ps", ["-axo", "pid=,comm=,args="], {
      encoding: "utf8",
      timeout: 10000,
      signal: controller.signal,
    });
    const candidates: { pid: string; name: string }[] = [];
    for (const line of ps.stdout.split("\n")) {
      const [pid, executable, ...args] = line.trim().split(/\s+/);
      const name = path.basename(executable ?? "");
      if (name === "treehouse" && args.includes("get"))
        throw new Error(
          "A Treehouse allocator still runs; wait for it to settle",
        );
      if (!["git", "ssh"].includes(name)) continue;
      candidates.push({ pid, name });
    }
    await mapWithConcurrency(
      candidates,
      LSOF_CONCURRENCY,
      async (candidate) => {
        let cwd: string;
        try {
          const lsof = await execFileAsync(
            "lsof",
            ["-a", "-p", candidate.pid, "-d", "cwd", "-Fn"],
            { encoding: "utf8", timeout: 5000, signal: controller.signal },
          );
          cwd =
            lsof.stdout
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
      },
    );
    return entries;
  } catch (error: any) {
    if (controller.signal.aborted)
      throw new Error(
        "Timed out inspecting Treehouse leases and allocator processes",
      );
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
export async function reconcileLaunch(
  store: Store,
  c: Conversation,
  inspect = inspectLaunchLeases,
) {
  const actor = { kind: "user" as const, id: "launch-recovery" };
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
    store.projectForTicket(store.ticket(c.ticketId!, actor)).remote
  )
    throw new Error("Ticket project changed");
  const holder = "firstmate-attempt-" + c.id;
  const entries = await inspect(project.source);
  if (!Array.isArray(entries)) throw new Error("Malformed Treehouse inventory");
  // The inspection above is asynchronous, so ownership, the worker's launch
  // identity, and the ticket it is dispatched under must all be reconfirmed
  // before any side effect below acts on stale, pre-wait assumptions.
  store.assertOwner();
  const currentConversation = store.conversation(c.id, actor);
  assertUnlaunched(currentConversation);
  const currentTicket = store.ticket(c.ticketId!, actor);
  if (
    currentTicket.handling !== "agent_managed" ||
    ["completed", "cancelled"].includes(currentTicket.status) ||
    !store.dependenciesSatisfied(c.ticketId!) ||
    store.projectForTicket(currentTicket).remote !== project.remote
  )
    throw new Error(
      "Ticket lifecycle changed during inspection; lease retained without requeuing",
    );
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
