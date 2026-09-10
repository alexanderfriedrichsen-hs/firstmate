import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { atomic, ownHome } from "./home.ts";
function digest(content: Buffer | string) {
  return createHash("sha256").update(content).digest("hex");
}
function overlaps(a: string, b: string) {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
function canonicalDestination(value: string) {
  let ancestor = path.resolve(value);
  const tail: string[] = [];
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...tail);
}
function rejectSymlinks(file: string) {
  let current = path.resolve(file);
  while (current !== path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Migration refuses symbolic links: " + current);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}
function guardApp(home: string) {
  for (const name of [
    "",
    "owner.lock",
    "control-mode",
    "state.sqlite",
    "state.sqlite-wal",
    "state.sqlite-shm",
    "cutover-journal.json",
    "cutover-receipt.json",
    "rollback-receipt.json",
    "objects",
    "migration-aborts",
  ])
    rejectSymlinks(path.join(fs.realpathSync(home), "app", name));
}
function validateDestination(store: Store, destination: string) {
  const resolved = canonicalDestination(destination);
  const homes = [
    fs.realpathSync(store.home),
    store.setting("lastImport")?.source,
  ].filter(Boolean);
  if (
    homes.some(
      (home) =>
        resolved === home ||
        resolved.startsWith(home + path.sep) ||
        home.startsWith(resolved + path.sep),
    )
  )
    throw new Error(
      "Rollback export must be outside and not overlap the app or legacy home",
    );
  if (
    fs.existsSync(resolved) &&
    (!fs.statSync(resolved).isDirectory() || fs.readdirSync(resolved).length)
  )
    throw new Error("Rollback destination must be absent or empty");
  return resolved;
}
export function snapshotLegacy(source: string) {
  const root = fs.realpathSync(source);
  const files: Record<
    string,
    { hash: string; size: number; mtimeMs: number; content: string }
  > = {};
  for (const sub of ["data", "state", "config"]) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const relative = path.join(sub, name);
      const file = path.join(root, relative);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      if (!(
        relative === "data/backlog.md" ||
        /^state\/[^/.]+\.(meta|status)$/.test(relative)
      ))
        continue;
      const content = fs.readFileSync(file);
      files[relative] = {
        hash: digest(content),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        content: content.toString("utf8"),
      };
    }
  }
  return {
    schema: "firstmate.shadow.v1",
    source: root,
    files,
    fingerprint: digest(JSON.stringify(files)),
    observedAt: new Date().toISOString(),
  };
}
function legacyStatus(section: string) {
  return /cancelled|canceled/i.test(section)
    ? "cancelled"
    : /done|complete|archive/i.test(section)
      ? "completed"
      : /in.flight|active|in.progress/i.test(section)
        ? "active"
        : "backlog";
}
export function importLegacy(store: Store, source: string) {
  const before = snapshotLegacy(source);
  if (!before.files["data/backlog.md"])
    throw new Error("Source has no legacy backlog");
  let section = "Unclassified";
  const rows: { id: string; line: string; section: string; index: number }[] =
    [];
  const unresolved: string[] = [];
  before.files["data/backlog.md"].content.split("\n").forEach((line, index) => {
    if (/^#+ /.test(line)) {
      section = line.replace(/^#+\s+/, "");
      return;
    }
    if (!/^[-*]\s+/.test(line)) {
      if (rows.length && line.trim()) rows[rows.length - 1].line += "\n" + line;
      return;
    }
    const id =
      line.match(/(?:`|\b)([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?:`|\b)/)?.[1] ??
      "freeform-" + digest(line).slice(0, 16);
    rows.push({ id, line, section, index });
  });
  let imported = 0,
    existing = 0;
  store.db.transaction(() => {
    for (const row of rows) {
      const mapped = store.db
        .prepare("SELECT ticket_id FROM imports WHERE source=? AND legacy_id=?")
        .get(before.source, row.id) as any;
      const metaText = before.files["state/" + row.id + ".meta"]?.content ?? "";
      const metadata = Object.fromEntries(
        metaText
          .split("\n")
          .filter((l) => l.includes("="))
          .map((l) => [
            l.slice(0, l.indexOf("=")),
            l.slice(l.indexOf("=") + 1),
          ]),
      );
      if (mapped) {
        store.db
          .prepare(
            "UPDATE wakes SET state='cancelled' WHERE ticket_id=? AND state!='handled'",
          )
          .run(mapped.ticket_id);
        existing++;
        const previous = store.setting("legacy:" + mapped.ticket_id);
        previous.holds = [
          ...row.line.matchAll(/(?:blocked-by|hold):\s*([^\n]+)/gi),
        ].map((match) => match[1]);
        store.setting("legacy:" + mapped.ticket_id, previous);
        if (/human.only|manual|private/i.test(row.section)) {
          const privateTicket = store.ticket(mapped.ticket_id, {
            kind: "user",
            id: "migration",
          });
          privateTicket.handling = "human_only";
          store.putTicket(privateTicket);
        }
        const mappedTicket = store.ticket(mapped.ticket_id, {
          kind: "user",
          id: "migration",
        });
        const derivedHandling = /human.only|manual|private/i.test(row.section)
          ? "human_only"
          : "agent_managed";
        const needsNormalization =
          mappedTicket.version === (previous?.lastImportedVersion ?? 1) &&
          (mappedTicket.status !== legacyStatus(row.section) ||
            mappedTicket.handling !== derivedHandling);
        const nextHistory =
          before.files["state/" + row.id + ".status"]?.content ?? "";
        if (
          needsNormalization ||
          previous?.raw !== row.line ||
          JSON.stringify(previous?.metadata) !== JSON.stringify(metadata) ||
          previous?.statusHistory !== nextHistory ||
          previous?.section !== row.section
        ) {
          const ticket = store.ticket(mapped.ticket_id, {
            kind: "user",
            id: "migration",
          });
          if (ticket.version !== (previous?.lastImportedVersion ?? 1)) {
            unresolved.push(
              row.id + ": local and legacy edits require reconciliation",
            );
            store.setting("migration-conflict:" + ticket.id, {
              legacy: row,
              metadata,
              statusHistory: nextHistory,
            });
          } else {
            ticket.brief = row.line;
            ticket.title = row.line
              .replace(/^\s*[-*]\s+(?:\[[ x]\]\s*)?/, "")
              .slice(0, 240);
            ticket.order = row.index;
            ticket.status = legacyStatus(row.section);
            ticket.handling = derivedHandling;
            ticket.version++;
            store.putTicket(ticket);
            store.setting("legacy:" + ticket.id, {
              ...previous,
              raw: row.line,
              section: row.section,
              metadata,
              statusHistory: nextHistory,
              lastImportedVersion: ticket.version,
            });
          }
        }
        continue;
      }
      const result = store.command(
        { kind: "user", id: "migration" },
        {
          commandId: randomUUID(),
          type: "ticket.create",
          payload: {
            title: row.line
              .replace(/^\s*[-*]\s+(?:\[[ x]\]\s*)?/, "")
              .slice(0, 240),
            brief: row.line,
            links: [
              ...new Set(
                row.line.match(
                  /https:\/\/github\.com\/[^\s/)]+\/[^\s/)]+\/pull\/\d+/g,
                ) ?? [],
              ),
            ].map((url) => ({ kind: "github_pr", url })),
            kind: metadata.kind === "scout" ? "investigation" : "change",
            handling: /human.only|manual|private/i.test(row.section)
              ? "human_only"
              : "agent_managed",
          },
        },
      );
      const ticket = result.ticket;
      store.db
        .prepare(
          "UPDATE wakes SET state='cancelled' WHERE ticket_id=? AND state!='handled'",
        )
        .run(ticket.id);
      ticket.status = legacyStatus(row.section);
      ticket.order = row.index;
      store.putTicket(ticket);
      store.setting("legacy:" + ticket.id, {
        source: before.source,
        legacyId: row.id,
        section: row.section,
        raw: row.line,
        metadata,
        statusHistory:
          before.files["state/" + row.id + ".status"]?.content ?? "",
        holds: [...row.line.matchAll(/(?:blocked-by|hold):\s*([^\n]+)/gi)].map(
          (match) => match[1],
        ),
        management: "external",
        lastImportedVersion: ticket.version,
        completion:
          ticket.status === "completed"
            ? "completed before migration; evidence unverified"
            : null,
      });
      store.db
        .prepare("INSERT INTO imports VALUES(?,?,?)")
        .run(before.source, row.id, ticket.id);
      if (!metaText) unresolved.push(row.id);
      imported++;
    }
    store.setting("shadowMode", true);
    store.setting("policy", { ...store.setting("policy"), paused: true });
    store.setting("lastImport", {
      source: before.source,
      fingerprint: before.fingerprint,
      observedAt: before.observedAt,
    });
    const after = snapshotLegacy(source);
    if (before.fingerprint !== after.fingerprint)
      throw new Error(
        "Legacy source changed during import; reconcile before cutover",
      );
  })();
  return {
    source: before.source,
    imported,
    existing,
    unresolved,
    sourceUnchanged: true,
    fingerprint: before.fingerprint,
    mode: "shadow",
    externallyManaged: true,
  };
}
export async function rollbackExport(store: Store, destination: string) {
  if (!store.setting("policy").paused)
    throw new Error("Pause dispatch before rollback export");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const actor = { kind: "user" as const, id: "rollback" };
  const tickets = store.tickets(actor);
  const record = (t: any) => ({
    ...store.detail(t.id, actor),
    conversations: store
      .conversations(actor)
      .filter((c) => c.ticketId === t.id),
  });
  const managed = tickets
    .filter((t) => t.handling === "agent_managed")
    .map(record);
  const human = tickets.filter((t) => t.handling === "human_only").map(record);
  atomic(
    path.join(destination, "managed.json"),
    JSON.stringify(managed, null, 2),
  );
  atomic(
    path.join(destination, "human-only.json"),
    JSON.stringify(human, null, 2),
  );
  atomic(
    path.join(destination, "backlog.md"),
    [
      "# Exported managed work",
      ...["Queued", "Active", "Done", "Cancelled"].flatMap((section) => {
        const rows = managed.filter(
          (r) =>
            (r.ticket.status === "completed"
              ? "Done"
              : r.ticket.status === "cancelled"
                ? "Cancelled"
                : r.ticket.status === "backlog"
                  ? "Queued"
                  : "Active") === section,
        );
        if (!rows.length) return [];
        return [
          "",
          "## " + section,
          ...rows.map((r) => {
            const id = r.legacy?.legacyId ?? r.ticket.slug;
            const title = r.ticket.title.replace(/[\r\n]+/g, " ");
            const details = [
              r.ticket.brief,
              ...r.ticket.links.map((l) => l.url),
            ]
              .filter(Boolean)
              .join("\n");
            return (
              `- [${r.ticket.status === "completed" ? "x" : " "}] ${id} - ${title}\n  App ticket: ${r.ticket.id}\n  Status: ${r.ticket.status}; priority: ${r.ticket.priority}` +
              (details
                ? "\n" +
                  details
                    .split("\n")
                    .map((line) => "  " + line)
                    .join("\n")
                : "")
            );
          }),
        ];
      }),
      "",
    ].join("\n"),
  );
  await store.backup(path.join(destination, "state.sqlite"));
  const objects = path.join(store.home, "app", "objects");
  if (fs.existsSync(objects))
    fs.cpSync(objects, path.join(destination, "objects"), { recursive: true });
  const parked = store
    .conversations(actor)
    .filter(
      (c) => !["idle", "failed", "lost"].includes(c.state) || c.providerId,
    )
    .map((c) => ({ id: c.id, providerId: c.providerId, state: c.state }));
  const report = {
    exportedAt: new Date().toISOString(),
    managedTickets: managed.length,
    humanOnlyTickets: human.length,
    parked,
    ownershipTransferred: false,
  };
  atomic(
    path.join(destination, "report.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}

export function prepareCutover(
  store: Store,
  source: string,
  repositoryRoot: string,
) {
  const snapshot = snapshotLegacy(source);
  const root = snapshot.source;
  const required = ["", "backends"].flatMap((sub) =>
    fs
      .readdirSync(path.join(repositoryRoot, "bin", sub))
      .filter((name) => name.endsWith(".sh"))
      .map((name) => path.join(sub, name)),
  );
  const missingFence = required.filter((name) => {
    const file = path.join(root, "bin", name);
    return (
      !fs.existsSync(file) ||
      digest(fs.readFileSync(file)) !==
        digest(fs.readFileSync(path.join(repositoryRoot, "bin", name)))
    );
  });
  const activeLocks: any[] = [];
  for (const relative of [
    "state/.lock",
    "state/.watch.lock/pid",
    "state/.afk-launch.lock/pid",
  ]) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    if (!fs.statSync(file).isFile()) {
      activeLocks.push({ path: relative, reason: "Unknown lock shape" });
      continue;
    }
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (!Number.isInteger(pid) || pid < 2) {
      activeLocks.push({ path: relative, reason: "Unknown lock identity" });
      continue;
    }
    try {
      process.kill(pid, 0);
      activeLocks.push({
        path: relative,
        pid,
        reason: "Quiesce this legacy owner before cutover",
      });
    } catch (error: any) {
      if (error.code !== "ESRCH")
        activeLocks.push({
          path: relative,
          reason: "Could not verify legacy owner exit",
        });
    }
  }
  const ownerFile = path.join(root, "app", "owner.lock");
  if (fs.existsSync(ownerFile)) {
    try {
      const holders = execFileSync(
        process.platform === "linux" ? "/usr/bin/lsof" : "/usr/sbin/lsof",
        ["-t", ownerFile],
        {
          encoding: "utf8",
          timeout: 5000,
        },
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const pid of new Set(holders))
        activeLocks.push({
          path: "app/owner.lock",
          pid: Number(pid),
          reason: "Existing process holds the common ownership descriptor",
        });
    } catch (error: any) {
      if (error.status !== 1)
        activeLocks.push({
          path: "app/owner.lock",
          reason: "Could not inspect ownership holders",
        });
    }
  }
  const migrationConflicts = store.db
    .prepare("SELECT key FROM settings WHERE key LIKE 'migration-conflict:%'")
    .all();
  const targetState: string[] = [];
  for (const name of [
    "control-mode",
    "state.sqlite",
    "cutover-receipt.json",
    "rollback-receipt.json",
  ]) {
    if (fs.existsSync(path.join(root, "app", name))) targetState.push(name);
  }
  const journalFile = path.join(root, "app", "cutover-journal.json");
  if (fs.existsSync(journalFile)) {
    try {
      if (readJson(journalFile).phase !== "aborted")
        targetState.push("cutover-journal.json");
    } catch {
      targetState.push("unreadable cutover-journal.json");
    }
  }
  const overlappingHomes = overlaps(root, fs.realpathSync(store.home));
  const report = {
    schema: "firstmate.cutover-report.v1",
    targetState,
    overlappingHomes,
    migrationConflicts,
    id: randomUUID(),
    source: root,
    stagingHome: store.home,
    repositoryRoot,
    sourceFingerprint: snapshot.fingerprint,
    preparedAt: new Date().toISOString(),
    missingFence,
    activeLocks,
    stagedNativeConversations: store.conversations({
      kind: "user",
      id: "migration",
    }).length,
    ready:
      !overlappingHomes &&
      targetState.length === 0 &&
      migrationConflicts.length === 0 &&
      missingFence.length === 0 &&
      activeLocks.length === 0 &&
      !!snapshot.files["data/backlog.md"] &&
      store.conversations({ kind: "user", id: "migration" }).length === 0,
    actions: [
      ...(overlappingHomes
        ? [
            "Use disjoint source and staging directories before preparing cutover.",
          ]
        : []),
      ...(targetState.length
        ? [
            "Existing target app state requires recovery or abort of its incomplete transfer, or archival and reconciliation of a completed or released migration before a new cutover.",
          ]
        : []),
      "Quiesce the old supervisor and watcher; retain workers.",
      "Install the reviewed common-fence entrypoints in the target home.",
      "Run cutover with this exact report ID after reviewing the backup and rollback results.",
    ],
    workerPolicy:
      "Retain legacy workers as externally managed. Bind only verified exact provider identities.",
  };
  store.setting("cutoverReport:" + report.id, report);
  return report;
}
function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function assertNoRunners(store: Store) {
  if (
    store.db
      .prepare(
        "SELECT id FROM outbox WHERE state IN ('pending','dispatching','uncertain') LIMIT 1",
      )
      .get()
  )
    throw new Error(
      "Resolve pending or ambiguous provider effects before releasing ownership",
    );
  const root = path.join(store.home, "app", "runners");
  if (fs.existsSync(root))
    for (const entry of fs.readdirSync(root)) {
      const file = path.join(root, entry, "identity.json");
      if (!fs.existsSync(file))
        throw new Error("Runner identity is ambiguous: " + entry);
      const identity = readJson(file);
      for (const key of ["pid", "providerPid"]) {
        const pid = identity[key];
        if (pid === undefined && key === "providerPid") continue;
        if (!Number.isInteger(pid) || pid < 2)
          throw new Error("Runner identity is ambiguous");
        try {
          process.kill(pid, 0);
        } catch (error: any) {
          if (error.code === "ESRCH") continue;
          throw error;
        }
        throw new Error(
          "Park and stop all app runners before releasing ownership",
        );
      }
    }
  for (const c of store.conversations({ kind: "user", id: "migration" })) {
    if (
      (c.providerId || c.runnerId) &&
      (!c.runnerId ||
        !fs.existsSync(path.join(root, c.runnerId, "identity.json")))
    )
      throw new Error(
        "Conversation runner identity is missing or ambiguous: " + c.id,
      );
  }
  if (
    store
      .conversations({ kind: "user", id: "migration" })
      .some((c) => !["idle", "lost", "failed"].includes(c.state))
  )
    throw new Error(
      "Resolve active or ambiguous conversations before releasing ownership",
    );
}
function approve(store: Store, report: any, id: string, key: string) {
  if (
    !report ||
    report.id !== id ||
    report.stagingHome !== store.home ||
    !report.ready ||
    JSON.stringify(store.setting(key + id)) !== JSON.stringify(report)
  )
    throw new Error(
      "Operation needs explicit approval of a ready report from this staging home",
    );
  if (!store.setting("policy").paused)
    throw new Error("Pause dispatch before ownership transfer");
}
export async function executeCutover(
  store: Store,
  report: any,
  approvalId: string,
) {
  return transfer(store, report, approvalId, false);
}
export async function recoverCutover(
  store: Store,
  report: any,
  approvalId: string,
) {
  return transfer(store, report, approvalId, true);
}
async function transfer(
  store: Store,
  report: any,
  approvalId: string,
  recovery: boolean,
) {
  approve(store, report, approvalId, "cutoverReport:");
  const source = fs.realpathSync(report.source);
  if (overlaps(source, fs.realpathSync(store.home)))
    throw new Error("Source and staging homes must be disjoint for cutover");
  guardApp(source);
  const app = path.join(source, "app");
  fs.mkdirSync(app, { recursive: true, mode: 0o700 });
  const release = ownHome(source);
  try {
    const receiptFile = path.join(app, "cutover-receipt.json");
    const journalFile = path.join(app, "cutover-journal.json");
    const markerFile = path.join(app, "control-mode");
    const refreshed = prepareCutover(store, source, report.repositoryRoot);
    const externalLocks = refreshed.activeLocks.filter(
      (lock: any) =>
        !(lock.path === "app/owner.lock" && lock.pid === process.pid),
    );
    if (
      refreshed.missingFence.length ||
      externalLocks.length ||
      refreshed.stagedNativeConversations ||
      refreshed.migrationConflicts.length
    )
      throw new Error(
        "Ownership or source changed; review a fresh cutover report",
      );
    if (fs.existsSync(receiptFile)) {
      const receipt = readJson(receiptFile);
      if (receipt.reportId !== report.id)
        throw new Error("Target records another ownership transfer");
      if (!fs.existsSync(markerFile) || readJson(markerFile).mode !== "app")
        throw new Error("Ownership was released or is ambiguous");
      store.setting("transferDestination", source);
      store.setting("shadowMode", true);
      return receipt;
    }
    let journal = fs.existsSync(journalFile) ? readJson(journalFile) : null;
    if (
      journal &&
      journal.backup !==
        path.join(store.home, "app", "migration-backups", journal.reportId)
    )
      throw new Error("Unexpected recovery backup path");
    if (journal) rejectSymlinks(journal.backup);
    if (journal?.phase === "aborted") {
      if (journal.reportId === report.id || fs.existsSync(markerFile))
        throw new Error("Transfer was aborted; prepare a fresh report");
      journal = null;
    }
    if (
      journal &&
      (!recovery ||
        journal.reportId !== report.id ||
        journal.stagingHome !== store.home)
    )
      throw new Error(
        "Incomplete transfer: recover using its exact approved report",
      );
    if (snapshotLegacy(source).fingerprint !== report.sourceFingerprint)
      throw new Error("Legacy state changed; prepare a fresh report");
    if (!journal) {
      if (
        fs.existsSync(markerFile) ||
        fs.existsSync(path.join(app, "state.sqlite"))
      )
        throw new Error("Target already has app state or ownership marker");
      const backup = path.join(
        store.home,
        "app",
        "migration-backups",
        report.id,
      );
      rejectSymlinks(backup);
      fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
      for (const name of ["state", "data", "config"])
        if (fs.existsSync(path.join(source, name)))
          fs.cpSync(path.join(source, name), path.join(backup, name), {
            recursive: true,
            dereference: false,
          });
      journal = {
        reportId: report.id,
        stagingHome: store.home,
        backup,
        phase: "prepared",
      };
      atomic(journalFile, JSON.stringify(journal));
    }
    if (
      fs.existsSync(markerFile) &&
      readJson(markerFile).reportId !== report.id
    )
      throw new Error("Ownership marker disagrees with recovery journal");
    atomic(
      markerFile,
      JSON.stringify({
        mode: "app",
        reportId: report.id,
        stagingHome: store.home,
      }),
    );
    // A complete immutable database image is built before publishing the target database.
    // Recovery only reuses this image; it never overwrites a runtime-modified target.
    const image = path.join(journal.backup, "transfer.sqlite");
    if (journal.phase === "prepared") {
      if (fs.existsSync(path.join(app, "state.sqlite")))
        throw new Error("Unexpected target database before image publication");
      importLegacy(store, source);
      const conflicts = store.db
        .prepare(
          "SELECT key FROM settings WHERE key LIKE 'migration-conflict:%'",
        )
        .all();
      if (conflicts.length)
        throw new Error("Resolve migration conflicts before recovery");
      store.setting("shadowMode", false);
      store.setting("legacyCheckpoint", snapshotLegacy(source));
      try {
        await store.backup(image);
      } finally {
        store.setting("shadowMode", true);
      }
      journal = {
        ...journal,
        phase: "image-ready",
        imageHash: digest(fs.readFileSync(image)),
      };
      atomic(journalFile, JSON.stringify(journal));
    }
    if (digest(fs.readFileSync(image)) !== journal.imageHash)
      throw new Error("Transfer image changed; recovery refused");
    const target = path.join(app, "state.sqlite");
    if (fs.existsSync(target)) {
      if (
        fs.existsSync(target + "-wal") ||
        digest(fs.readFileSync(target)) !== journal.imageHash
      )
        throw new Error("Target database changed; recovery refused");
    } else atomic(target, fs.readFileSync(image));
    const objects = path.join(store.home, "app", "objects");
    if (fs.existsSync(objects))
      fs.cpSync(objects, path.join(app, "objects"), { recursive: true });
    const receipt = {
      schema: "firstmate.ownership.v1",
      complete: true,
      reportId: report.id,
      source,
      backup: journal.backup,
      transferredAt: new Date().toISOString(),
      paused: true,
      workerSessions: "retained externally",
    };
    atomic(receiptFile, JSON.stringify(receipt, null, 2));
    store.setting("transferDestination", source);
    store.setting("shadowMode", true);
    return receipt;
  } finally {
    release();
  }
}
export function prepareRollback(store: Store, destination: string) {
  guardApp(store.home);
  assertNoRunners(store);
  const receipt = readJson(
    path.join(store.home, "app", "cutover-receipt.json"),
  );
  const report = {
    schema: "firstmate.rollback-report.v1",
    id: randomUUID(),
    stagingHome: store.home,
    destination: validateDestination(store, destination),
    transferReportId: receipt.reportId,
    ready: !!store.setting("policy").paused,
    generation: store.setting("generation"),
    eventSequence: store.db
      .prepare("SELECT MAX(sequence) AS n FROM events")
      .get(),
  };
  if (
    report.destination === store.home ||
    report.destination.startsWith(store.home + path.sep)
  )
    throw new Error("Rollback export must be outside the app home");
  store.setting("rollbackReport:" + report.id, report);
  return report;
}
export async function executeRollback(
  store: Store,
  report: any,
  approvalId: string,
  options: { ownershipHeld?: boolean } = {},
) {
  approve(store, report, approvalId, "rollbackReport:");
  guardApp(store.home);
  const release = options.ownershipHeld ? () => {} : ownHome(store.home);
  try {
    const app = path.join(store.home, "app");
    const file = path.join(app, "rollback-receipt.json");
    if (fs.existsSync(file) || store.setting("ownershipReleased")) {
      const receipt = fs.existsSync(file)
        ? readJson(file)
        : store.setting("ownershipReleased");
      if (receipt.reportId !== report.id)
        throw new Error("Another rollback is already recorded");
      if (!fs.existsSync(file)) atomic(file, JSON.stringify(receipt, null, 2));
      if (fs.existsSync(path.join(app, "control-mode"))) {
        if (
          readJson(path.join(app, "control-mode")).reportId !==
          report.transferReportId
        )
          throw new Error("Ownership changed after rollback");
        fs.unlinkSync(path.join(app, "control-mode"));
      }
      return receipt;
    }
    assertNoRunners(store);
    if (
      JSON.stringify(
        store.db.prepare("SELECT MAX(sequence) AS n FROM events").get(),
      ) !== JSON.stringify(report.eventSequence)
    )
      throw new Error("App changed; review a fresh rollback report");
    const marker = readJson(path.join(app, "control-mode"));
    if (marker.reportId !== report.transferReportId || marker.mode !== "app")
      throw new Error("Ownership marker disagrees with rollback report");
    if (validateDestination(store, report.destination) !== report.destination)
      throw new Error("Rollback destination changed");
    await rollbackExport(store, report.destination);
    // Do not overwrite legacy state with app history. The managed export is reviewable,
    // and private records remain exclusively in the private export and retained DB.
    const receipt = {
      schema: "firstmate.rollback.v1",
      reportId: report.id,
      export: report.destination,
      ownershipTransferred: true,
      legacyStateUnchanged: true,
      releasedAt: new Date().toISOString(),
    };
    store.setting("shadowMode", true);
    store.setting("ownershipReleased", receipt);
    atomic(file, JSON.stringify(receipt, null, 2));
    fs.unlinkSync(path.join(app, "control-mode"));
    const fd = fs.openSync(app, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return receipt;
  } finally {
    release();
  }
}

export async function abortCutover(
  store: Store,
  report: any,
  approvalId: string,
) {
  approve(store, report, approvalId, "cutoverReport:");
  const source = fs.realpathSync(report.source);
  if (source === fs.realpathSync(store.home))
    throw new Error("Abort requires the original staging home");
  guardApp(source);
  const app = path.join(source, "app");
  const release = ownHome(source);
  try {
    if (fs.existsSync(path.join(app, "cutover-receipt.json")))
      throw new Error("Completed transfers require rollback, not abort");
    const journalFile = path.join(app, "cutover-journal.json");
    const journal = readJson(journalFile);
    if (journal.reportId !== report.id || journal.stagingHome !== store.home)
      throw new Error("Abort report disagrees with transfer journal");
    const marker = path.join(app, "control-mode");
    if (fs.existsSync(marker) && readJson(marker).reportId !== report.id)
      throw new Error("Abort ownership marker is ambiguous");
    const runners = path.join(app, "runners");
    if (fs.existsSync(runners) && fs.readdirSync(runners).length)
      throw new Error("Target runner state is ambiguous; abort refused");
    const target = path.join(app, "state.sqlite");
    if (fs.existsSync(target + "-wal") || fs.existsSync(target + "-shm"))
      throw new Error("Target runtime state is ambiguous; abort refused");
    if (
      fs.existsSync(target) &&
      (!journal.imageHash ||
        digest(fs.readFileSync(target)) !== journal.imageHash)
    )
      throw new Error("Target database changed; abort refused");
    const archive = path.join(app, "migration-aborts", report.id);
    rejectSymlinks(archive);
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    for (const name of ["state.sqlite", "objects"]) {
      const file = path.join(app, name);
      if (fs.existsSync(file)) {
        const archived = path.join(archive, name);
        if (fs.existsSync(archived))
          throw new Error("Abort archive collision; inspect retained state");
        fs.renameSync(file, archived);
      }
    }
    atomic(
      journalFile,
      JSON.stringify({ ...journal, phase: "aborted", archive }),
    );
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const fd = fs.openSync(app, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return {
      reportId: report.id,
      aborted: true,
      archive,
      legacyStateUnchanged: true,
    };
  } finally {
    release();
  }
}
