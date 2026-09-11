import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Store } from "./store.ts";
const run = promisify(execFile);
export async function observeExternalPr(
  store: Store,
  ticketId: string,
  api = (route: string) =>
    run("gh", ["api", route], {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    }).then((r) => JSON.parse(r.stdout)),
) {
  const actor = { kind: "collector" as const, id: "external-pr-observer" };
  const ticket = store.ticket(ticketId, actor);
  if (
    !store.externallyManaged(ticketId) ||
    ["completed", "cancelled"].includes(ticket.status)
  )
    return;
  for (const link of ticket.links
    .filter((l) => l.kind === "github_pr")
    .slice(0, 3)) {
    const u = new URL(link.url);
    const m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/);
    if (u.protocol !== "https:" || u.hostname !== "github.com" || !m)
      throw Error("Invalid external PR association");
    const pr = await api(`repos/${m[1]}/${m[2]}/pulls/${m[3]}`);
    if (
      !["open", "closed"].includes(pr.state) ||
      typeof pr.merged !== "boolean" ||
      typeof pr.draft !== "boolean" ||
      typeof pr.head?.sha !== "string"
    )
      throw Error("Incomplete GitHub PR observation");
    store.assertOwner();
    const current = store.ticket(ticketId, actor);
    if (
      !store.externallyManaged(ticketId) ||
      ["completed", "cancelled"].includes(current.status) ||
      JSON.stringify(current.links) !== JSON.stringify(ticket.links)
    )
      return;
    const result = {
      url: link.url,
      state: pr.state,
      merged: pr.merged,
      draft: pr.draft,
      head: pr.head?.sha,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex");
    const key = "external-pr:" + ticketId + ":" + link.url;
    const previous = store.setting(key);
    if (previous?.digest === digest) continue;
    const ordinal = (previous?.ordinal ?? 0) + 1;
    store.db.transaction(() => {
      const artifactId = store.artifact(
        ticketId,
        "external-pr-observation.json",
        JSON.stringify(result, null, 2),
        "application/json",
      );
      store.setting(key, {
        digest,
        ordinal,
        artifactId,
        observedAt: new Date().toISOString(),
      });
      store.db.prepare("INSERT OR IGNORE INTO wakes VALUES(?,?,?,?,?)").run(
        "external-pr:" + ticketId + ":" + digest + ":" + ordinal,
        ticketId,
        "pending",
        JSON.stringify({
          kind: "external.prChanged",
          observationOnly: true,
          artifactId,
          observation: result,
          instruction:
            "Inspect read-only PR observation. Do not claim native validation or change ownership/completion automatically.",
        }),
        new Date().toISOString(),
      );
      store.event("external.prChanged", ticketId, { artifactId }, ticketId);
    })();
  }
}
