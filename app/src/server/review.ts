import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.ts";
import { now, type Conversation } from "../contracts.ts";
export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "resolvedFindingIds"],
  properties: {
    verdict: { type: "string", enum: ["passed", "failed"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "severity", "location"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["blocking", "important", "nit"] },
          location: { type: "string" },
        },
      },
    },
    resolvedFindingIds: { type: "array", items: { type: "string" } },
  },
};
const resultSchema = z
  .object({
    verdict: z.enum(["passed", "failed"]),
    summary: z.string(),
    findings: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        severity: z.enum(["blocking", "important", "nit"]),
        location: z.string(),
      }),
    ),
    resolvedFindingIds: z.array(z.string()),
  })
  .strict();
export function collectReview(store: Store, c: Conversation, text: string) {
  if (!c.ticketId || c.stage !== "review" || !c.reviewRevision)
    throw new Error("Review conversation has no assigned revision");
  const result = resultSchema.parse(JSON.parse(text));
  if (
    result.verdict === "passed" &&
    result.findings.some((f) => f.severity === "blocking")
  )
    throw new Error("Review reports both a pass and blocking findings");
  const actor = { kind: "collector" as const, id: "review:" + c.id };
  const t = store.ticket(c.ticketId, actor);
  const evidenceKey =
    "review-result:" +
    c.id +
    ":" +
    c.incarnation +
    ":" +
    (store.setting("last-turn:" + c.id)?.turnId ?? c.reviewRevision);
  if (store.setting(evidenceKey)) return;
  const artifactId = store.artifact(
    t.id,
    "review.json",
    JSON.stringify(result, null, 2),
    "application/json",
  );
  store.db.transaction(() => {
    for (const f of result.findings)
      store.db.prepare("INSERT INTO findings VALUES(?,?,?)").run(
        randomUUID(),
        t.id,
        JSON.stringify({
          ...f,
          revision: c.reviewRevision,
          conversationId: c.id,
          status: "open",
        }),
      );
    for (const id of result.resolvedFindingIds) {
      const row = store.db
        .prepare("SELECT data FROM findings WHERE id=? AND ticket_id=?")
        .get(id, t.id) as any;
      if (row && t.revision === c.reviewRevision) {
        const f = JSON.parse(row.data);
        if (String(f.source ?? "").startsWith("github-review-")) continue;
        store.db.prepare("UPDATE findings SET data=? WHERE id=?").run(
          JSON.stringify({
            ...f,
            status: "resolved",
            resolvedBy: c.id,
            resolvedRevision: c.reviewRevision,
          }),
          id,
        );
      }
    }
    store.command(actor, {
      commandId: randomUUID(),
      type: "evidence.register",
      targetId: t.id,
      expectedVersion: t.version,
      payload: {
        revision: c.reviewRevision,
        requirement: "review",
        verdict: result.verdict,
        provenance: "independent-native-review:" + c.id,
        artifactId,
      },
    });
    store.setting(evidenceKey, { artifactId, collectedAt: now() });
  })();
}
