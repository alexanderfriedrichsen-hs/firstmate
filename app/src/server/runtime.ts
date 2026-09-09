import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { recordContext, collectOutputs, recordNativeReads } from "./library.ts";
import { observeLegacy } from "./legacy-observer.ts";
import { launchDraft, collectDraft } from "./drafts.ts";
import { collectReview, reviewSchema } from "./review.ts";
import { collectPullRequests } from "./github.ts";
import { git } from "./revisions.ts";
import { launchChecks, collectChecks } from "./checks.ts";
import { retryDecision } from "./revisions.ts";
import { claudeUsage } from "./usage.ts";
import { alive, atomic } from "./home.ts";
import { now, type Conversation } from "../contracts.ts";
const internal = { kind: "user" as const, id: "runtime" };
export class Runtime {
  busy = false;
  stopped = false;
  owns() {
    if (this.stopped) return false;
    try {
      this.store.assertOwner();
      return true;
    } catch {
      return false;
    }
  }
  nextLegacyObservation = 0;
  timer?: NodeJS.Timeout;
  constructor(public store: Store) {}
  start() {
    this.stopped = false;
    // Read-only remote collection is safe to repeat after an interrupted read.
    this.store.db
      .prepare(
        "UPDATE outbox SET state='pending' WHERE kind='ticket.refreshPr' AND state='dispatching'",
      )
      .run();
    for (const row of this.store.db
      .prepare("SELECT key,value FROM settings WHERE key LIKE 'draft:%'")
      .all() as any[]) {
      const job = JSON.parse(row.value);
      if (job.state === "collecting")
        this.store.setting(row.key, { ...job, state: "running" });
    }
    this.timer = setInterval(() => void this.tick(), 500);
    void this.tick();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.store.assertOwner();
      for (const c of this.store.conversations(internal)) {
        this.ingest(c);
        this.reconcile(c);
      }
      collectChecks(this.store);
      if (Date.now() >= this.nextLegacyObservation) {
        this.nextLegacyObservation = Date.now() + 15000;
        observeLegacy(this.store);
      }
      for (const row of this.store.db
        .prepare("SELECT key,value FROM settings WHERE key LIKE 'draft:%'")
        .all() as any[]) {
        const job = JSON.parse(row.value);
        if (
          job.state === "running" &&
          fs.existsSync(
            path.join(this.store.home, "app", "drafts", job.id, "result.json"),
          )
        ) {
          this.store.setting(row.key, { ...job, state: "collecting" });
          void collectDraft(this.store, row.key).catch((error) => {
            if (!this.owns()) return;
            this.store.setting(row.key, {
              ...job,
              state: "needs_reconciliation",
              error: String(error),
            });
          });
        }
      }
      this.scheduleRetries();
      this.scheduleWakes();
      this.schedulePrPolls();
      const jobs = this.store.db
        .prepare(
          "SELECT * FROM outbox WHERE state='pending' ORDER BY created_at",
        )
        .all() as any[];
      for (const job of jobs) {
        if (
          this.store.setting("policy").paused &&
          !["conversation.interrupt", "permission.reply"].includes(job.kind)
        )
          continue;
        const c = [
          "stage.retry",
          "ticket.validate",
          "ticket.refreshPr",
          "ticket.draftPr",
        ].includes(job.kind)
          ? null
          : this.store.conversation(job.target_id, internal);
        const commandActor = JSON.parse(
          (
            this.store.db
              .prepare("SELECT actor FROM commands WHERE id=?")
              .get(job.command_id) as any
          )?.actor ?? "{}",
        );
        if (
          c &&
          c.inputOwner !== "automation" &&
          job.kind === "conversation.send" &&
          commandActor.kind !== "user"
        )
          continue;
        if (c && ["conversation.send"].includes(job.kind) && c.state !== "idle")
          continue;
        this.store.db
          .prepare(
            "UPDATE outbox SET state='dispatching',generation=? WHERE id=? AND state='pending'",
          )
          .run(this.store.generation, job.id);
        try {
          if (
            job.kind === "conversation.launch" ||
            job.kind === "conversation.resume"
          )
            await this.launch(c!);
          else if (c) {
            const p = JSON.parse(job.payload);
            p.model = c.model;
            p.effort = c.effort;
            for (const skill of p.skills ?? []) {
              recordContext(
                this.store,
                c,
                path.basename(skill.path),
                fs.readFileSync(skill.path, "utf8"),
                "Prepared explicit skill input for dispatch; provider acceptance is recorded in the turn history",
                skill.path,
              );
            }
            if (p.attachments)
              p.attachments = p.attachments.map((id: string) => {
                const record = this.store.db
                  .prepare(
                    "SELECT a.* FROM artifacts a JOIN artifact_access access ON access.artifact_id=a.id WHERE a.id=? AND access.conversation_id=?",
                  )
                  .get(id, c.id) as any;
                if (!record) throw new Error("Attachment association changed");
                return {
                  name: record.name,
                  mediaType: record.media_type,
                  base64: fs
                    .readFileSync(
                      path.join(this.store.home, "app", "objects", id),
                    )
                    .toString("base64"),
                };
              });
            const type =
              job.kind === "permission.reply"
                ? "permission"
                : job.kind.split(".")[1];
            await this.request(c, { id: job.id, type, ...p });
          } else if (job.kind === "ticket.validate")
            launchChecks(this.store, job.target_id, job.id);
          else if (job.kind === "ticket.draftPr") {
            void launchDraft(this.store, job)
              .then(() => {
                if (!this.owns()) return;
                this.store.db
                  .prepare("UPDATE outbox SET state='accepted' WHERE id=?")
                  .run(job.id);
              })
              .catch((error) => {
                if (!this.owns()) return;
                this.store.db
                  .prepare("UPDATE outbox SET state='uncertain' WHERE id=?")
                  .run(job.id);
                this.store.event(
                  "draft.dispatchFailed",
                  job.target_id,
                  { error: String(error) },
                  job.target_id,
                );
              });
            continue;
          } else if (job.kind === "ticket.refreshPr") {
            void this.refreshPr(job);
            continue;
          } else await this.retry(job);
          this.store.db
            .prepare("UPDATE outbox SET state='accepted' WHERE id=?")
            .run(job.id);
        } catch (e) {
          this.store.db
            .prepare("UPDATE outbox SET state='uncertain' WHERE id=?")
            .run(job.id);
          this.store.event(
            "dispatch.uncertain",
            job.target_id,
            { error: String(e), jobId: job.id },
            c?.ticketId,
          );
        }
      }
    } catch (e) {
      if (this.owns()) this.store.setting("runtimeError", String(e));
    } finally {
      this.busy = false;
    }
  }
  async refreshPr(job: any) {
    try {
      await collectPullRequests(this.store, job.target_id);
      this.store.assertOwner();
      this.store.db
        .prepare("UPDATE outbox SET state='accepted' WHERE id=?")
        .run(job.id);
    } catch (error) {
      if (!this.owns()) return;
      this.store.db
        .prepare("UPDATE outbox SET state='failed' WHERE id=?")
        .run(job.id);
      this.store.event(
        "pr.collectionFailed",
        job.target_id,
        { jobId: job.id, error: String(error) },
        job.target_id,
      );
    }
  }
  schedulePrPolls() {
    if (this.store.setting("policy").paused || this.store.setting("shadowMode"))
      return;
    for (const ticket of this.store.tickets({
      kind: "supervisor",
      id: "poller",
    })) {
      if (
        !ticket.revision ||
        ["completed", "cancelled"].includes(ticket.status)
      )
        continue;
      const links = ticket.links.filter((l) => l.kind === "github_pr");
      if (
        !links.length ||
        !links.some(
          (l) =>
            (this.store.setting("pr:" + l.url)?.nextPollAt ?? 0) <= Date.now(),
        )
      )
        continue;
      if ((this.store.setting("pr-poll:" + ticket.id) ?? 0) > Date.now())
        continue;
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM outbox WHERE target_id=? AND kind='ticket.refreshPr' AND state IN ('pending','dispatching')",
          )
          .get(ticket.id)
      )
        continue;
      this.store.command(
        { kind: "collector", id: "pr-poller" },
        {
          commandId: randomUUID(),
          type: "ticket.refreshPr",
          targetId: ticket.id,
          expectedVersion: ticket.version,
          payload: {},
        },
      );
      this.store.setting("pr-poll:" + ticket.id, Date.now() + 300000);
    }
  }
  scheduleRetries() {
    if (this.store.setting("policy").paused) return;
    for (const schedule of this.store.db
      .prepare("SELECT * FROM retries WHERE state='scheduled' AND due_at<=?")
      .all(now()) as any[]) {
      const t = this.store.ticket(schedule.ticket_id, internal);
      if ((t.revision ?? null) !== schedule.revision) {
        this.store.db
          .prepare("UPDATE retries SET state='obsolete' WHERE id=?")
          .run(schedule.id);
        continue;
      }
      try {
        this.store.command(
          { kind: "collector", id: "retry-scheduler" },
          {
            commandId: schedule.id,
            type: "stage.retry",
            targetId: t.id,
            expectedVersion: t.version,
            payload: { stage: schedule.stage },
          },
        );
      } catch (error) {
        this.store.db
          .prepare("UPDATE retries SET state='blocked' WHERE id=?")
          .run(schedule.id);
        this.store.event(
          "retry.blocked",
          t.id,
          { reason: String(error) },
          t.id,
        );
      }
    }
  }
  async retry(job: any) {
    const p = JSON.parse(job.payload);
    const t = this.store.ticket(job.target_id, internal);
    if (
      t.revision !== p.revision ||
      t.handling === "human_only" ||
      ["completed", "cancelled"].includes(t.status)
    )
      throw new Error("Retry revision or lifecycle changed");
    const prior = this.store.attempts(t.id).find((a) => a.id === p.parentId);
    if (!prior) throw new Error("Retry parent not found");
    const c = this.store.conversation(prior.conversationId, internal);
    if (c.inputOwner !== "automation")
      throw new Error("Retry is blocked by takeover");
    const status = await this.request(c, { type: "status" });
    if (status.state !== "idle")
      throw new Error("Provider is not settled; reconcile it before retry");
    const existing = this.store
      .attempts(t.id)
      .find((a) => a.parentId === prior.id && !a.endedAt);
    if (existing) throw new Error("Retry already owns an active attempt");
    this.store.putAttempt({
      id: randomUUID(),
      ticketId: t.id,
      conversationId: c.id,
      role: p.stage,
      state: "starting",
      revision: t.revision,
      ordinal:
        this.store.attempts(t.id).filter((a) => a.role === p.stage).length + 1,
      parentId: prior.id,
      createdAt: now(),
    });
    await this.request(c, {
      id: job.id,
      type: "send",
      messageId: randomUUID(),
      text:
        "Retry the previous " +
        p.stage +
        " stage against the current revision. Preserve prior results. Brief: " +
        t.brief,
    });
    c.state = "running";
    c.version++;
    this.store.putConversation(c);
  }
  reconcile(c: Conversation) {
    if (!c.runnerId || c.state === "planned") return;
    const identity = this.identity(c);
    if (
      identity &&
      alive(identity.pid, identity.startIdentity) &&
      identity.state === "idle" &&
      ["interrupted", "failed"].includes(c.state)
    ) {
      c.state = "idle";
      c.version++;
      this.store.putConversation(c);
      this.store.event(
        "conversation.reconciled",
        c.id,
        { state: "idle", reason: "Verified surviving runner is idle" },
        c.ticketId,
      );
    }
    if (
      identity &&
      !alive(identity.pid, identity.startIdentity) &&
      !["lost", "failed"].includes(c.state)
    ) {
      c.state = "lost";
      c.version++;
      this.store.putConversation(c);
      this.store.event(
        "conversation.lost",
        c.id,
        {
          reason:
            "Runner process exited; exact session resume requires reconciliation",
        },
        c.ticketId,
      );
    }
  }
  scheduleWakes() {
    if (this.store.setting("policy").paused) return;
    const supervisor = this.store
      .conversations(internal)
      .find((c) => c.role === "supervisor" && !c.retiredAt);
    if (
      !supervisor ||
      supervisor.state !== "idle" ||
      supervisor.inputOwner !== "automation"
    )
      return;
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM outbox WHERE target_id=? AND state IN ('pending','dispatching')",
        )
        .get(supervisor.id)
    )
      return;
    const wake = (
      this.store.db
        .prepare(
          "SELECT * FROM wakes WHERE state IN ('pending','presented') ORDER BY created_at",
        )
        .all() as any[]
    ).find((w) => {
      const d = JSON.parse(w.data);
      return (
        (d.presentations ?? 0) < 3 &&
        (!d.nextAt || Date.parse(d.nextAt) <= Date.now())
      );
    });
    if (!wake) return;
    if (wake.ticket_id) {
      const t = this.store.ticket(wake.ticket_id, internal);
      if (
        t.handling === "human_only" ||
        ["completed", "cancelled"].includes(t.status)
      ) {
        this.store.db
          .prepare("UPDATE wakes SET state='cancelled' WHERE id=?")
          .run(wake.id);
        return;
      }
    }
    const data = JSON.parse(wake.data);
    this.store.db.transaction(() => {
      this.store.command(
        { kind: "collector", id: "scheduler" },
        {
          commandId: randomUUID(),
          type: "conversation.send",
          targetId: supervisor.id,
          expectedVersion: supervisor.version,
          payload: {
            text: `Actionable managed-work wake ${wake.id}: ${JSON.stringify(data)}. Inspect the current ticket, handle authorized follow-up, then commit wake.ack with this id. Ending your turn alone does not acknowledge it.`,
          },
        },
      );
      this.store.db
        .prepare("UPDATE wakes SET state='presented',data=? WHERE id=?")
        .run(
          JSON.stringify({
            ...data,
            presentations: (data.presentations ?? 0) + 1,
            nextAt: new Date(Date.now() + 600000).toISOString(),
          }),
          wake.id,
        );
    })();
  }
  async launch(c: Conversation) {
    if (c.runnerId) {
      const old = this.identity(c);
      if (old && alive(old.pid, old.startIdentity))
        throw new Error(
          "Existing runner is alive; reconcile its control before resuming",
        );
      if (old?.providerPid && alive(old.providerPid, old.providerStartIdentity))
        throw new Error(
          "Old provider process survives its runner; reconcile its process group before resuming",
        );
    }
    if (c.ticketId) {
      const t = this.store.ticket(c.ticketId, internal);
      if (
        t.handling === "human_only" ||
        ["completed", "cancelled"].includes(t.status)
      )
        throw new Error("Ticket cannot dispatch");
      if (!c.providerId) {
        const source = this.store.setting("project").source;
        const allocation = JSON.parse(
          execFileSync(
            "treehouse",
            [
              "get",
              "--lease",
              "--json",
              "--lease-holder",
              "firstmate-attempt-" + c.id,
            ],
            { cwd: source, encoding: "utf8" },
          ),
        );
        const root = fs.realpathSync(allocation.path);
        const remote = execFileSync("git", ["remote", "get-url", "origin"], {
          cwd: root,
          encoding: "utf8",
        }).trim();
        if (remote !== this.store.setting("project").remote)
          throw new Error("Allocated repository identity differs");
        c.cwd = root;
        if (c.stage === "review" || c.stage === "repair") {
          const revision = this.store.setting(
            "revision:" + (c.reviewRevision ?? c.baseRevision),
          );
          git(
            root,
            c.stage === "review"
              ? ["switch", "--detach", revision.head]
              : ["switch", "-c", "firstmate/repair-" + c.id, revision.head],
          );
        }
        this.store.setting("lease:" + c.id, { ...allocation, remote });
      }
    }
    c.incarnation++;
    c.runnerId = randomUUID();
    c.state = "starting";
    c.version++;
    const dir = path.join(this.store.home, "app", "runners", c.runnerId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const socketDir = path.join(
      os.tmpdir(),
      "fm-" +
        createHash("sha256").update(this.store.home).digest("hex").slice(0, 12),
    );
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    const socket = path.join(socketDir, c.runnerId.slice(0, 16) + ".sock");
    const executable = execFileSync(
      "/bin/zsh",
      ["-lc", "command -v " + (c.provider === "codex" ? "codex" : "claude")],
      { encoding: "utf8" },
    ).trim();
    const token = randomBytes(32).toString("hex");
    const tokens = this.store.setting("agentTokens") ?? [];
    tokens.push({
      token,
      actor: {
        kind: c.role === "supervisor" ? "supervisor" : "worker",
        id: c.id,
        ...(c.ticketId ? { ticketId: c.ticketId } : {}),
      },
    });
    this.store.setting("agentTokens", tokens);
    const tokenFile = path.join(dir, "agent-token");
    atomic(tokenFile, token);
    fs.mkdirSync(c.cwd, { recursive: true, mode: 0o700 });
    const loader = fileURLToPath(
      new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
    );
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const transferFlag = fs.existsSync(
      path.join(this.store.home, "app", "cutover-receipt.json"),
    )
      ? " --transferred-home"
      : "";
    const instructions =
      "You are a Firstmate " +
      c.role +
      ". Work only within the assigned workspace and explicit authorization. Never merge, request reviewers, mark PRs ready, change Linear status, or change account billing without a matching user action. Report concise outcomes and evidence. A completed turn does not complete a ticket. Save user-facing reports, Markdown, images, HTML, and PDFs under the outputs/ directory in this workspace; Firstmate imports them into the app after each turn. Preserve normal project instructions. Do not inspect any other Firstmate home. " +
      (c.role === "supervisor"
        ? "Use the scoped Firstmate agent CLI to inspect managed tickets and submit commands. Human-only records are unavailable."
        : "") +
      ` Agent CLI: ${process.execPath} --import ${loader} ${cli}${transferFlag} read --resource snapshot --json. To submit a command, write a JSON envelope to a file in your cwd and invoke the same CLI with command --file <path> --json. FM_AGENT_TOKEN_FILE and FM_HOME are supplied in your environment; never print or read credential contents. Envelopes use commandId (new UUID), type, targetId, expectedVersion, and payload. Read snapshot for IDs and versions. You may ticket.create with title/brief/kind, conversation.create with role worker/ticketId/provider/model, conversation.send with text, and wake.ack with id after handling. When a worker finishes a change, request ticket.validate with empty payload to freeze and independently check the committed revision. Then request ticket.review with empty payload for independent review, ticket.refreshPr for linked CI and merge evidence, or ticket.repair for a bounded repair of current findings. Use current ticket versions. ticket.draftPr requires an explicitly authorized project, title, and body; it never requests reviewers or merges. Do not mark evidence passed yourself.`;
    recordContext(
      this.store,
      c,
      "firstmate-session-instructions.md",
      instructions,
      "App instructions supplied at native session initialization",
    );
    atomic(
      path.join(dir, "config.json"),
      JSON.stringify({
        runnerProtocol: 3,
        runnerId: c.runnerId,
        incarnation: c.incarnation,
        provider: c.provider,
        providerId: c.providerId,
        model: c.model,
        effort: c.effort,
        cwd: c.cwd,
        executable,
        socket,
        instructions,
        tokenFile,
        stage: c.stage,
        outputSchema: c.stage === "review" ? reviewSchema : undefined,
      }),
    );
    this.store.putConversation(c);
    const log = fs.openSync(path.join(dir, "runner.log"), "a", 0o600);
    const runner = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./runner.ts", import.meta.url)),
        path.join(dir, "config.json"),
      ],
      {
        detached: true,
        stdio: ["ignore", log, log],
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: {
          ...process.env,
          FM_HOME: this.store.home,
          FM_AGENT_TOKEN_FILE: tokenFile,
        },
      },
    );
    runner.unref();
    fs.closeSync(log);
    if (c.ticketId) {
      const t = this.store.ticket(c.ticketId, internal);
      const role =
        c.stage ?? (t.kind === "investigation" ? "investigate" : "implement");
      this.store.putAttempt({
        id: randomUUID(),
        ticketId: t.id,
        conversationId: c.id,
        role,
        state: "starting",
        revision: t.revision,
        ordinal: this.store.attempts(t.id).length + 1,
        createdAt: now(),
      });
      t.status = "active";
      t.version++;
      this.store.putTicket(t);
    }
    this.store.event("conversation.updated", c.id, c, c.ticketId);
  }
  identity(c: Conversation) {
    try {
      return JSON.parse(
        fs.readFileSync(
          path.join(
            this.store.home,
            "app",
            "runners",
            c.runnerId!,
            "identity.json",
          ),
          "utf8",
        ),
      );
    } catch {
      return null;
    }
  }
  request(c: Conversation, payload: any) {
    const identity = this.identity(c);
    if (!identity || !alive(identity.pid, identity.startIdentity))
      return Promise.reject(new Error("Runner identity is unavailable"));
    return new Promise<any>((resolve, reject) => {
      const socket = net.createConnection(identity.socket);
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Receipt unknown after runner timeout"));
      }, 15000);
      socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
      socket.on("data", (b) => {
        buffer += b;
        const i = buffer.indexOf("\n");
        if (i < 0) return;
        clearTimeout(timer);
        socket.end();
        try {
          const msg = JSON.parse(buffer.slice(0, i));
          msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
        } catch (e) {
          reject(e);
        }
      });
      socket.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
  ingest(c: Conversation) {
    if (!c.runnerId) return;
    const file = path.join(
      this.store.home,
      "app",
      "runners",
      c.runnerId,
      "events.jsonl",
    );
    if (!fs.existsSync(file)) return;
    const offsetKey = "offset:" + c.runnerId;
    const offset = this.store.setting(offsetKey) ?? 0;
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const last = buf.lastIndexOf(10);
    if (last < 0) return;
    this.store.db.transaction(() => {
      for (const line of buf.subarray(0, last).toString().split("\n")) {
        const e = JSON.parse(line);
        if (
          !this.store.db
            .prepare("INSERT OR IGNORE INTO runner_events VALUES(?,?,?)")
            .run(c.runnerId, c.incarnation, e.sequence).changes
        )
          continue;
        this.apply(c, e);
      }
      this.store.setting(offsetKey, offset + last + 1);
    })();
  }
  apply(c: Conversation, e: any) {
    const prior = JSON.stringify([c.state, c.providerId, c.model]);
    const p = e.payload;
    if (e.type === "conversation.bound") {
      c.providerId = p.providerId;
      if (p.model) c.model = p.model;
    }
    if (e.type === "runner.ready" || e.type === "runner.settled")
      c.state = "idle";
    if (e.type === "runner.failed" || e.type === "provider.exit")
      c.state = "lost";
    if (
      ["permission.expired", "runner.failed", "provider.exit"].includes(e.type)
    )
      this.store.db
        .prepare(
          "UPDATE permissions SET state='expired' WHERE conversation_id=? AND state IN ('pending','answering')",
        )
        .run(c.id);
    if (e.type === "permission.request") {
      this.store.db
        .prepare("INSERT OR IGNORE INTO permissions VALUES(?,?,?,?)")
        .run(p.id, c.id, "pending", JSON.stringify(p));
      c.state = "waiting_permission";
    }
    if (e.type === "permission.answered") {
      this.store.db
        .prepare("UPDATE permissions SET state='answered' WHERE id=?")
        .run(p.id);
      c.state = this.store.db
        .prepare(
          "SELECT 1 FROM permissions WHERE conversation_id=? AND state IN ('pending','answering')",
        )
        .get(c.id)
        ? "waiting_permission"
        : "running";
    }
    if (e.type === "command.accepted")
      this.store.db
        .prepare("UPDATE outbox SET state='accepted' WHERE id=?")
        .run(p.id);
    if (e.type === "provider.event") {
      const v = p.params;
      const item = v?.item;
      if (p.method === "turn/started") c.state = "running";
      if (p.method === "turn/completed") {
        this.store.db
          .prepare(
            "UPDATE permissions SET state='expired' WHERE conversation_id=? AND state IN ('pending','answering')",
          )
          .run(c.id);
        c.state = "idle";
        this.store.setting("last-turn:" + c.id, {
          status: v.turn.status,
          turnId: v.turn.id,
          error: v.turn.error,
        });
        this.settle(
          c,
          v.turn.status === "completed" ? "succeeded" : v.turn.status,
          v.turn.error?.codexErrorInfo === "usageLimitExceeded"
            ? "rate_limit"
            : v.turn.error?.codexErrorInfo === "serverOverloaded"
              ? "service_unavailable"
              : undefined,
        );
      }
      if (p.method === "item/agentMessage/delta") {
        const id = c.id + ":" + v.itemId;
        const old = this.store.db
          .prepare("SELECT content FROM messages WHERE id=?")
          .get(id) as any;
        this.store.message(
          c.id,
          id,
          "assistant",
          (old?.content ?? "") + v.delta,
          "message",
          v.itemId,
        );
      }
      if (p.method === "item/completed" && item) {
        recordNativeReads(this.store, c, item);
        if (item.type === "agentMessage")
          this.store.message(
            c.id,
            c.id + ":" + item.id,
            "assistant",
            item.text,
            "message",
            item.id,
          );
        else if (
          [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "webSearch",
          ].includes(item.type)
        ) {
          const artifactId = this.store.artifact(
            c.ticketId,
            item.type + ".json",
            JSON.stringify(item, null, 2),
            "application/json",
            c.id,
          );
          this.store.message(
            c.id,
            c.id + ":" + item.id,
            "tool",
            JSON.stringify({ label: item.type, artifactId }),
            "activity",
            item.id,
          );
        }
      }
      if (p.method === "thread/tokenUsage/updated") {
        const total = v.tokenUsage.total;
        const key = "usage-total:" + c.id;
        const previous = this.store.setting(key) ?? {
          inputTokens: 0,
          outputTokens: 0,
        };
        const input = Math.max(0, total.inputTokens - previous.inputTokens);
        const output = Math.max(0, total.outputTokens - previous.outputTokens);
        this.store.db
          .prepare("INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?,?,?)")
          .run(
            c.runnerId + ":" + e.sequence,
            c.id,
            c.model,
            input,
            output,
            JSON.stringify({
              provider: c.provider,
              role: c.role,
              coverage: "measured",
              raw: v,
              timezone: "America/Los_Angeles",
              ticketId: c.ticketId,
            }),
            e.at,
          );
        this.store.setting(key, total);
      }
    }
    if (e.type === "claude.event") {
      if (p.type === "stream_event") {
        const event = p.event;
        const key = "claude-message:" + c.id;
        if (event.type === "message_start")
          this.store.setting(key, event.message.id);
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        ) {
          const mid = this.store.setting(key);
          if (mid) {
            const id = c.id + ":" + mid;
            const old = this.store.db
              .prepare("SELECT content FROM messages WHERE id=?")
              .get(id) as any;
            this.store.message(
              c.id,
              id,
              "assistant",
              (old?.content ?? "") + event.delta.text,
              "message",
              mid,
            );
          }
        }
      }
      if (p.type === "assistant") {
        for (const block of p.message.content ?? [])
          if (
            block.type === "tool_use" &&
            block.name === "Read" &&
            /\.md$/i.test(block.input?.file_path ?? "")
          )
            this.store.setting(
              "context-read:" + c.id + ":" + block.id,
              block.input.file_path,
            );
        const mid = p.message.id ?? p.uuid;
        const text = (p.message.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        if (text)
          this.store.message(
            c.id,
            c.id + ":" + mid,
            "assistant",
            text,
            "message",
            mid,
          );
      }
      if (p.type === "user")
        for (const block of p.message?.content ?? []) {
          const file = this.store.setting(
            "context-read:" + c.id + ":" + block.tool_use_id,
          );
          if (block.type === "tool_result" && !block.is_error && file)
            recordContext(
              this.store,
              c,
              path.basename(file),
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
              "Provider-reported Markdown read result; may be partial",
              file,
            );
        }
      if (p.type === "result") {
        c.state = "idle";
        this.settle(
          c,
          p.firstmateInterrupted
            ? "interrupted"
            : p.is_error
              ? "failed"
              : "succeeded",
        );
        for (const u of claudeUsage(p, c.model))
          this.store.db
            .prepare("INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?,?,?)")
            .run(
              c.id + ":" + p.uuid + ":" + u.model,
              c.id,
              u.model,
              u.input,
              u.output,
              JSON.stringify({
                provider: c.provider,
                role: c.role,
                coverage: u.input === null ? "unavailable" : "measured",
                raw: u.raw,
                ticketId: c.ticketId,
                timezone: "America/Los_Angeles",
              }),
              e.at,
            );
      }
    }
    if (c.ticketId && ["runner.ready", "provider.event"].includes(e.type)) {
      for (const attempt of this.store
        .attempts(c.ticketId)
        .filter((a) => a.conversationId === c.id && !a.endedAt)) {
        if (c.state === "running" || c.state === "waiting_permission")
          attempt.state = c.state;
        else if (c.state === "idle" && attempt.state === "starting")
          attempt.state = "ready";
        this.store.putAttempt(attempt);
      }
    }
    if (prior !== JSON.stringify([c.state, c.providerId, c.model])) c.version++;
    this.store.putConversation(c);
    this.store.event(
      "conversation.updated",
      c.id,
      { state: c.state, version: c.version },
      c.ticketId,
    );
  }
  settle(c: Conversation, state: string, errorClass?: string) {
    collectOutputs(this.store, c);
    if (!c.ticketId) return;
    if (c.stage === "review" && state === "succeeded") {
      try {
        const message = this.store
          .messages(c.id)
          .filter((m) => m.role === "assistant")
          .at(-1);
        if (message) collectReview(this.store, c, message.content);
      } catch (error) {
        this.store.event(
          "review.invalidResult",
          c.id,
          { reason: String(error) },
          c.ticketId,
        );
        state = "failed";
      }
    }
    for (const a of this.store
      .attempts(c.ticketId)
      .filter((a) => a.conversationId === c.id && !a.endedAt)) {
      a.state = state;
      a.endedAt = now();
      this.store.putAttempt(a);
      const t = this.store.ticket(c.ticketId, internal);
      if (
        errorClass &&
        t.handling === "agent_managed" &&
        !["completed", "cancelled"].includes(t.status) &&
        c.inputOwner === "automation"
      ) {
        const decision = retryDecision({
          errorClass,
          ordinal: a.ordinal,
          elapsedMs: Date.now() - Date.parse(a.createdAt),
          allowance: true,
          writerAlive: false,
          uncertain: false,
        });
        if (decision.eligible)
          this.store.db
            .prepare("INSERT INTO retries VALUES(?,?,?,?,?,?,?)")
            .run(
              randomUUID(),
              t.id,
              t.revision ?? null,
              a.role,
              "scheduled",
              new Date(Date.now() + decision.delayMs!).toISOString(),
              JSON.stringify({ errorClass, parentId: a.id, policyVersion: 1 }),
            );
      }
    }
    const t = this.store.ticket(c.ticketId, internal);
    if (!["completed", "cancelled"].includes(t.status))
      this.store.db
        .prepare("INSERT OR IGNORE INTO wakes VALUES(?,?,?,?,?)")
        .run(
          c.id + ":" + c.incarnation + ":" + state,
          t.id,
          "pending",
          JSON.stringify({
            kind: "attempt.settled",
            conversationId: c.id,
            state,
          }),
          now(),
        );
  }
}
