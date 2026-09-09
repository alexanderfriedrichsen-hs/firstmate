import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { atomic } from "./home.ts";
function digest(content: Buffer | string) {
  return createHash("sha256").update(content).digest("hex");
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
        existing++;
        const previous = store.setting("legacy:" + mapped.ticket_id);
        const nextHistory =
          before.files["state/" + row.id + ".status"]?.content ?? "";
        if (
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
            ticket.status = /done|complete|archive/i.test(row.section)
              ? "completed"
              : "backlog";
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
          },
        },
      );
      const ticket = result.ticket;
      ticket.status = /done|complete|archive/i.test(row.section)
        ? "completed"
        : "backlog";
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
    } catch {}
  }
  const ownerFile = path.join(root, "app", "owner.lock");
  if (fs.existsSync(ownerFile)) {
    try {
      const holders = execFileSync("/usr/sbin/lsof", ["-t", ownerFile], {
        encoding: "utf8",
        timeout: 5000,
      })
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
  const report = {
    schema: "firstmate.cutover-report.v1",
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
      missingFence.length === 0 &&
      activeLocks.length === 0 &&
      !!snapshot.files["data/backlog.md"] &&
      store.conversations({ kind: "user", id: "migration" }).length === 0,
    actions: [
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
export async function executeCutover(
  store: Store,
  report: any,
  approvalId: string,
) {
  if (
    report.id !== approvalId ||
    report.stagingHome !== store.home ||
    !report.ready
  )
    throw new Error(
      "Cutover needs explicit approval of a ready report from this staging home",
    );
  if (!store.setting("policy").paused)
    throw new Error("Pause staging dispatch before cutover");
  const source = fs.realpathSync(report.source);
  if (source === store.home)
    throw new Error("Use a separate staging home for cutover");
  const current = snapshotLegacy(source);
  if (current.fingerprint !== report.sourceFingerprint)
    throw new Error("Legacy state changed; prepare and review a fresh report");
  const refreshed = prepareCutover(store, source, report.repositoryRoot);
  if (
    !refreshed.ready ||
    refreshed.sourceFingerprint !== report.sourceFingerprint
  )
    throw new Error(
      "Ownership or source changed; review a fresh cutover report",
    );
  const appDir = path.join(source, "app");
  fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
  const { ownHome, atomic: publish } = await import("./home.ts");
  const release = ownHome(source);
  try {
    const receiptFile = path.join(appDir, "cutover-receipt.json");
    if (fs.existsSync(receiptFile)) {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      if (receipt.reportId === report.id) return receipt;
      throw new Error("Target already records another ownership transfer");
    }
    if (fs.existsSync(path.join(appDir, "state.sqlite")))
      throw new Error(
        "Target already has app state; reconcile it instead of overwriting",
      );
    if (snapshotLegacy(source).fingerprint !== report.sourceFingerprint)
      throw new Error(
        "Legacy state changed before exclusive ownership was acquired",
      );
    const backup = path.join(store.home, "app", "migration-backups", report.id);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const name of ["state", "data", "config"])
      if (fs.existsSync(path.join(source, name)))
        fs.cpSync(path.join(source, name), path.join(backup, name), {
          recursive: true,
          dereference: false,
        });
    // The persistent marker fences every upgraded shell path before the final delta.
    publish(
      path.join(appDir, "control-mode"),
      JSON.stringify({
        mode: "app",
        reportId: report.id,
        stagingHome: store.home,
        createdAt: new Date().toISOString(),
      }),
    );
    try {
      importLegacy(store, source);
      store.setting("shadowMode", false);
      store.setting("legacyCheckpoint", snapshotLegacy(source));
      await store.backup(path.join(appDir, "state.sqlite"));
      store.setting("transferDestination", source);
      store.setting("shadowMode", true);
      const objects = path.join(store.home, "app", "objects");
      if (fs.existsSync(objects))
        fs.cpSync(objects, path.join(appDir, "objects"), { recursive: true });
    } catch (error) {
      throw new Error(
        "Transfer is fenced but incomplete. Keep both supervisors paused and recover from the staged backup: " +
          String(error),
      );
    }
    const receipt = {
      schema: "firstmate.ownership.v1",
      complete: true,
      reportId: report.id,
      source,
      backup,
      transferredAt: new Date().toISOString(),
      paused: true,
      workerSessions: "retained externally",
      nextAction:
        "Start exactly one app runtime against the target home after reviewing the retained attempts.",
    };
    publish(receiptFile, JSON.stringify(receipt, null, 2));
    return receipt;
  } finally {
    release();
  }
}
