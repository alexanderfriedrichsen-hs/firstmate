import { joineraTool } from "./joinera-tools.ts";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { now } from "../contracts.ts";
import { hash } from "./revisions.ts";
const run = promisify(execFile);
export async function collectPullRequests(
  store: Store,
  ticketId: string,
  readApi?: (route: string) => Promise<any>,
) {
  const actor = { kind: "collector" as const, id: "github-collector" };
  let t = store.ticket(ticketId, actor);
  if (!t.revision)
    throw new Error("Freeze a revision before collecting PR evidence");
  const expectedRevision = t.revision;
  const ensureCurrent = () => {
    store.assertOwner();
    const current = store.ticket(ticketId, {
      kind: "user",
      id: "collection-state-check",
    });
    if (
      current.handling !== "agent_managed" ||
      ["completed", "cancelled"].includes(current.status) ||
      current.revision !== expectedRevision ||
      JSON.stringify(current.links) !== JSON.stringify(t.links)
    )
      throw new Error("Ticket changed during PR collection");
  };
  const revision = store.setting("revision:" + t.revision);
  if (!revision?.head)
    throw new Error("Current revision is not a verified Git revision");
  const links = t.links.filter((l) => l.kind === "github_pr");
  if (!links.length) throw new Error("Add a GitHub PR link first");
  for (const link of links) {
    const u = new URL(link.url);
    const [, owner, repo, , number] = u.pathname.split("/");
    if (u.hostname !== "github.com" || !/^\d+$/.test(number))
      throw new Error("Invalid GitHub PR association");
    const remote = revision.repository.replace(/\.git$/, "");
    if (
      !remote.endsWith("/" + owner + "/" + repo) &&
      !remote.endsWith(":" + owner + "/" + repo)
    )
      throw new Error("PR repository differs from the revision");
    const api =
      readApi ??
      (async (route: string) =>
        JSON.parse(
          (
            await run("gh", ["api", route], {
              maxBuffer: 16 * 1024 * 1024,
              timeout: 30000,
            })
          ).stdout,
        ));
    if (owner === "joinhandshake" && repo === "joinera" && !readApi) {
      const source = store.setting("revision-source:" + t.revision);
      if (!source?.cwd)
        throw new Error(
          "Joinera collection requires the associated revision workspace",
        );
      const reportFile = path.join(
        store.home,
        "app",
        "joinera-report-" + randomUUID() + ".json",
      );
      await run(
        joineraTool("validation"),
        ["report", "--pr", number, "--output", reportFile, "--no-linear"],
        { cwd: source.cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120000 },
      );
      ensureCurrent();
      store.setting("joinera-report:" + t.id, {
        artifactId: store.artifact(
          t.id,
          "joinera-validation-report.json",
          fs.readFileSync(reportFile, "utf8"),
          "application/json",
        ),
        observedAt: now(),
      });
      fs.unlinkSync(reportFile);
    }
    const pr = await api(`repos/${owner}/${repo}/pulls/${number}`);
    const [checks, status, reviews, comments] = await Promise.all([
      api(
        `repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
      ),
      api(`repos/${owner}/${repo}/commits/${pr.head.sha}/status`),
      api(`repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`),
      api(`repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`),
    ]);
    const mergeCommit =
      pr.merged && pr.merge_commit_sha
        ? await api(`repos/${owner}/${repo}/git/commits/${pr.merge_commit_sha}`)
        : null;
    const mergeMatchesFrozenBase =
      !!mergeCommit &&
      mergeCommit.tree?.sha === revision.tree &&
      mergeCommit.parents?.some((parent: any) => parent.sha === revision.base);
    ensureCurrent();
    const data = {
      pr,
      checks,
      status,
      reviews,
      comments,
      mergeCommit,
      observedAt: now(),
    };
    const artifactId = store.artifact(
      t.id,
      "github-pr-" + number + ".json",
      JSON.stringify(data, null, 2),
      "application/json",
    );
    const previous = store.setting("pr:" + link.url);
    const digest = hash({
      head: pr.head.sha,
      base: pr.base.sha,
      merged: pr.merged,
      mergeCommit: pr.merge_commit_sha,
      requiredChecks: store.setting("project")?.requiredChecks ?? [],
      state: pr.state,
      checks: checks.check_runs?.map((r: any) => [
        r.id,
        r.status,
        r.conclusion,
      ]),
      status: status.state,
      reviews: reviews.map((r: any) => [r.id, r.state]),
      comments: comments.map((r: any) => r.id),
    });
    store.setting("pr:" + link.url, {
      digest,
      revision: t.revision,
      artifactId,
      head: pr.head.sha,
      base: pr.base.sha,
      observedAt: now(),
      nextPollAt: Date.now() + 300000,
    });
    if (previous?.digest === digest && previous?.revision === t.revision)
      continue;
    t = store.ticket(ticketId, actor);
    if (
      pr.head.sha !== revision.head ||
      (pr.base.sha !== revision.base && !mergeMatchesFrozenBase)
    ) {
      store.setting("remote-drift:" + t.id + ":" + link.url, {
        revision: t.revision,
        head: pr.head.sha,
        base: pr.base.sha,
      });
      if (!["completed", "cancelled"].includes(t.status)) {
        t.status = "active";
        t.version++;
        store.putTicket(t);
      }
      store.event(
        "revision.remoteDrift",
        t.id,
        { url: link.url, head: pr.head.sha, base: pr.base.sha, artifactId },
        t.id,
      );
      continue;
    }
    store.setting("remote-drift:" + t.id + ":" + link.url, null);
    const checkNames = new Map<string, any>();
    for (const check of [...(checks.check_runs ?? [])].sort(
      (a: any, b: any) => a.id - b.id,
    ))
      checkNames.set(String(check.app?.id) + ":" + check.name, check);
    const allChecks = [...checkNames.values()];
    const requiredContexts: string[] =
      store.setting("project")?.requiredChecks ?? [];
    const observedNames = new Set([
      ...allChecks.map((r: any) => r.name),
      ...(status.statuses ?? []).map((s: any) => s.context),
    ]);
    const enough =
      requiredContexts.length > 0 &&
      requiredContexts.every((name) => observedNames.has(name)) &&
      reviews.length < 100 &&
      comments.length < 100 &&
      (allChecks.length > 0 || status.statuses.length > 0) &&
      checks.total_count <= 100 &&
      status.total_count <= 100;
    const passed =
      enough &&
      allChecks.every(
        (r: any) => r.status === "completed" && r.conclusion === "success",
      ) &&
      (status.statuses.length === 0 || status.state === "success");
    const failed =
      allChecks.some((r: any) =>
        ["failure", "cancelled", "timed_out", "action_required"].includes(
          r.conclusion,
        ),
      ) ||
      status.state === "failure" ||
      status.state === "error";
    store.command(actor, {
      commandId: randomUUID(),
      type: "evidence.register",
      targetId: t.id,
      expectedVersion: t.version,
      payload: {
        revision: t.revision,
        requirement: "ci:" + link.url,
        verdict: passed ? "passed" : failed ? "failed" : "unknown",
        provenance: "github:" + link.url,
        artifactId,
      },
    });
    t = store.ticket(ticketId, actor);
    const latestReviews = new Map<string, any>();
    for (const review of [...reviews].sort((a: any, b: any) => a.id - b.id)) {
      if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
        latestReviews.set(
          String(review.user?.id ?? review.user?.login ?? review.id),
          review,
        );
    }
    for (const [reviewer, review] of latestReviews) {
      const id =
        "github-review-" +
        hash({ ticket: t.id, url: link.url, reviewer }).slice(0, 24);
      const existing = store.db
        .prepare("SELECT data FROM findings WHERE id=?")
        .get(id) as any;
      if (review.state === "CHANGES_REQUESTED") {
        store.db
          .prepare(
            "INSERT INTO findings VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
          )
          .run(
            id,
            t.id,
            JSON.stringify({
              title: "GitHub review requests changes",
              description: review.body,
              location: review.html_url,
              severity: "blocking",
              status: "open",
              revision: t.revision,
              source: id,
              reviewId: review.id,
            }),
          );
      } else if (existing) {
        const finding = JSON.parse(existing.data);
        store.db.prepare("UPDATE findings SET data=? WHERE id=?").run(
          JSON.stringify({
            ...finding,
            status: "resolved",
            resolvedBy: "github:" + review.state,
            reviewId: review.id,
          }),
          id,
        );
      }
    }
    store.evaluate(t, false);
    store.putTicket(t);
    if (pr.merged && mergeMatchesFrozenBase) {
      store.setting("verified-merge:" + link.url, {
        revision: t.revision,
        mergeCommit: pr.merge_commit_sha,
        artifactId,
      });
      store.command(actor, {
        commandId: randomUUID(),
        type: "evidence.register",
        targetId: t.id,
        expectedVersion: t.version,
        payload: {
          revision: t.revision,
          requirement: "merge:" + link.url,
          verdict: "passed",
          provenance: "github-verified-merged-head:" + pr.head.sha,
          artifactId,
        },
      });
      t = store.ticket(ticketId, actor);
      try {
        store.command(actor, {
          commandId: randomUUID(),
          type: "ticket.claimComplete",
          targetId: t.id,
          expectedVersion: t.version,
          payload: {
            rationale:
              "GitHub confirms this exact PR head is merged, with current required evidence.",
          },
        });
      } catch {
        /* An unmet completion predicate remains a visible decision. */
      }
    }
    if (!["completed", "cancelled"].includes(t.status))
      store.db
        .prepare("INSERT OR IGNORE INTO wakes VALUES(?,?,?,?,?)")
        .run(
          "github:" + digest,
          t.id,
          "pending",
          JSON.stringify({ kind: "github.changed", url: link.url, artifactId }),
          now(),
        );
  }
}
