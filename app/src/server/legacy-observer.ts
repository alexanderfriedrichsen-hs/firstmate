import { Store } from "./store.ts";
import { snapshotLegacy } from "./migration.ts";
import { now } from "../contracts.ts";

// Observe externally retained workers without granting legacy files authority
// over the app's ticket state or publishing private records to a model.
export function observeLegacy(store: Store) {
  const checkpoint = store.setting("legacyCheckpoint");
  if (!checkpoint || store.setting("shadowMode")) return;
  const current = snapshotLegacy(checkpoint.source);
  const previous = store.setting("legacyObservation") ?? checkpoint;
  if (current.fingerprint === previous.fingerprint) return;
  const changed = [
    ...new Set([...Object.keys(previous.files), ...Object.keys(current.files)]),
  ].filter((name) => previous.files[name]?.hash !== current.files[name]?.hash);
  store.setting("legacyObservation", current);
  store.setting("legacyExternalChanges", {
    observedAt: now(),
    changed,
    requiresReconciliation: true,
  });
  for (const name of changed) {
    const id = name.match(/^state\/([^/]+)\.status$/)?.[1];
    if (!id) continue;
    const mapping = store.db
      .prepare("SELECT ticket_id FROM imports WHERE source=? AND legacy_id=?")
      .get(checkpoint.source, id) as any;
    if (!mapping) continue;
    const ticket = store.ticket(mapping.ticket_id, {
      kind: "user",
      id: "legacy-observer",
    });
    if (
      ticket.handling !== "agent_managed" ||
      ["completed", "cancelled"].includes(ticket.status)
    )
      continue;
    const artifactId = store.artifact(
      ticket.id,
      "external-worker-status.txt",
      current.files[name]?.content ?? "External status file removed",
      "text/plain",
    );
    const key = "legacy-status:" + ticket.id + ":" + current.fingerprint;
    store.db
      .prepare("INSERT OR IGNORE INTO wakes VALUES(?,?,?,?,?)")
      .run(
        key,
        ticket.id,
        "pending",
        JSON.stringify({
          kind: "external.workerStatus",
          ticketId: ticket.id,
          artifactId,
        }),
        now(),
      );
    store.event(
      "external.workerStatus",
      ticket.id,
      { artifactId, requiresReconciliation: true },
      ticket.id,
    );
  }
}
