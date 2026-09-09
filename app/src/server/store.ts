import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import {
  commandSchema,
  handling,
  priority,
  now,
  type Actor,
  type Command,
  type Ticket,
  type Conversation,
  type Attempt,
} from "../contracts.ts";
import { atomic } from "./home.ts";
import { git } from "./revisions.ts";
import { claudeUsage } from "./usage.ts";
const json = (s: string) => JSON.parse(s);
export class Conflict extends Error {
  status = 409;
}
export class Denied extends Error {
  status = 404;
}
export class Store {
  db: Database.Database;
  generation = 0;
  constructor(
    public home: string,
    readonly = false,
  ) {
    this.db = new Database(path.join(home, "app", "state.sqlite"), {
      readonly,
      fileMustExist: readonly,
    });
    if (readonly) return;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'",
        )
        .get() &&
      this.setting("ownershipReleased")
    ) {
      this.db.pragma("query_only = ON");
      return;
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, handling TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,ticket_id TEXT REFERENCES tickets(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, actor TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,ticket_id TEXT REFERENCES tickets(id),type TEXT NOT NULL,aggregate_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES commands(id) DEFERRABLE INITIALLY DEFERRED,kind TEXT NOT NULL,target_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',generation INTEGER,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,provider_id TEXT,sequence INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,UNIQUE(conversation_id,provider_id));
 CREATE TABLE IF NOT EXISTS runner_events(runner_id TEXT NOT NULL,incarnation INTEGER NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(runner_id,incarnation,sequence));
 CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),revision TEXT NOT NULL,requirement TEXT NOT NULL,verdict TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS findings(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS closures(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS retries(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),revision TEXT,stage TEXT NOT NULL,state TEXT NOT NULL,due_at TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS permissions(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),state TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),model TEXT NOT NULL,input INTEGER,output INTEGER,data TEXT NOT NULL,observed_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,ticket_id TEXT REFERENCES tickets(id),media_type TEXT NOT NULL,size INTEGER NOT NULL,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS artifact_access(artifact_id TEXT NOT NULL REFERENCES artifacts(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),PRIMARY KEY(artifact_id,conversation_id));
 CREATE TABLE IF NOT EXISTS message_attachments(message_id TEXT NOT NULL REFERENCES messages(id),artifact_id TEXT NOT NULL REFERENCES artifacts(id),PRIMARY KEY(message_id,artifact_id));
 CREATE TABLE IF NOT EXISTS dependencies(ticket_id TEXT NOT NULL REFERENCES tickets(id),requires_id TEXT NOT NULL REFERENCES tickets(id),criterion TEXT NOT NULL,PRIMARY KEY(ticket_id,requires_id));
 CREATE TABLE IF NOT EXISTS imports(source TEXT NOT NULL,legacy_id TEXT NOT NULL,ticket_id TEXT NOT NULL REFERENCES tickets(id),PRIMARY KEY(source,legacy_id));
 CREATE TABLE IF NOT EXISTS wakes(id TEXT PRIMARY KEY,ticket_id TEXT REFERENCES tickets(id),state TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
 INSERT OR IGNORE INTO migrations VALUES(1,datetime('now'));`);
    if (!this.db.prepare("SELECT 1 FROM migrations WHERE version=2").get())
      this.db.transaction(() => {
        for (const row of this.db
          .prepare("SELECT * FROM usage")
          .all() as any[]) {
          const data = json(row.data);
          if (data.provider !== "claude" || !data.raw?.[row.model]) continue;
          this.db.prepare("DELETE FROM usage WHERE id=?").run(row.id);
          for (const usage of claudeUsage({ modelUsage: data.raw }, row.model))
            this.db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?)").run(
              row.id + ":" + usage.model,
              row.conversation_id,
              usage.model,
              usage.input,
              usage.output,
              JSON.stringify({
                ...data,
                raw: usage.raw,
                normalizationVersion: 2,
              }),
              row.observed_at,
            );
        }
        this.db.prepare("INSERT INTO migrations VALUES(2,?)").run(now());
      })();
    if (!this.setting("policy"))
      this.setting("policy", {
        version: 1,
        retry: { totalAttempts: 3, backoff: [30000, 120000], repairCycles: 3 },
        cursor: {
          enabled: false,
          unit: "input_plus_output_tokens",
          amount: 5000,
          period: "calendar_month",
          timezone: "America/Los_Angeles",
          rollover: false,
        },
        paused: true,
      });
  }
  requireCurrentRunner(c: Conversation, minimum = 2) {
    if (!c.runnerId) return;
    const file = path.join(
      this.home,
      "app",
      "runners",
      c.runnerId,
      "config.json",
    );
    const config = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : {};
    if ((config.runnerProtocol ?? 0) < minimum)
      throw new Conflict(
        "Park and resume the exact session to load model, effort, and skill controls in this older runner.",
      );
  }
  setting(key: string, value?: unknown): any {
    if (value !== undefined) {
      this.assertWritable();
      this.db
        .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
        .run(key, JSON.stringify(value));
      if (key === "ownershipReleased" && value)
        this.db.pragma("query_only = ON");
    }
    return json(
      (
        this.db
          .prepare("SELECT value FROM settings WHERE key=?")
          .get(key) as any
      )?.value ?? "null",
    );
  }
  fence() {
    this.generation = this.db.transaction(() => {
      const g = (this.setting("generation") ?? 0) + 1;
      this.setting("generation", g);
      return g;
    })();
    return this.generation;
  }
  assertWritable() {
    if (this.setting("ownershipReleased"))
      throw new Conflict(
        "App ownership was released; this history is read-only",
      );
  }
  externallyManaged(ticketId: string) {
    return this.setting("legacy:" + ticketId)?.management === "external";
  }
  adoptionEligibility(t: Ticket) {
    const legacy = this.setting("legacy:" + t.id);
    if (
      legacy?.management !== "external" ||
      !["queued", "backlog"].includes(t.status) ||
      t.handling !== "agent_managed"
    )
      return {
        eligible: false,
        reason: "Only a queued externally managed ticket can be adopted",
      };
    if (!this.setting("project")?.source)
      return {
        eligible: false,
        reason: "Configure a project source before adopting queued work",
      };
    if (this.setting("migration-conflict:" + t.id))
      return {
        eligible: false,
        reason:
          "Resolve conflicting legacy updates before adopting this ticket",
      };
    const descriptive = new Set([
      "kind",
      "title",
      "description",
      "priority",
      "created_at",
      "createdAt",
    ]);
    if (
      Object.entries(legacy.metadata ?? {}).some(
        ([key, value]) =>
          !descriptive.has(key) &&
          value !== null &&
          value !== undefined &&
          String(value).trim() !== "",
      ) ||
      legacy.statusHistory?.trim() ||
      legacy.holds?.length ||
      this.attempts(t.id).length ||
      this.conversations({ kind: "user", id: "adoption" }).some(
        (entry) => entry.ticketId === t.id,
      )
    )
      return {
        eligible: false,
        reason:
          "Legacy worker identity or history requires reconciliation; adoption is blocked",
      };
    return {
      eligible: true,
      reason:
        "Adopt this queued task into the configured project; automatic work follows your dispatch and Firstmate control settings",
    };
  }
  assertLeaseActive(conversationId: string) {
    if (
      this.setting("lease-retirement-intent:conversation:" + conversationId) ||
      this.setting("retired-lease:conversation:" + conversationId)
    )
      throw new Conflict(
        "Conversation lease retirement is recorded; preserve history and reconcile before any further input",
      );
  }
  assertManaged(ticketId: string) {
    if (this.externallyManaged(ticketId))
      throw new Conflict(
        "Legacy ticket is externally managed; no app worker can dispatch",
      );
  }
  assertOwner() {
    this.assertWritable();
    if (this.generation !== this.setting("generation"))
      throw new Conflict("Stale runtime generation");
  }
  visible(actor: Actor, t: Ticket) {
    return (
      actor.kind === "user" ||
      (t.handling !== "human_only" &&
        (!actor.ticketId || actor.ticketId === t.id))
    );
  }
  ticket(id: string, actor: Actor): Ticket {
    const r = this.db
      .prepare("SELECT data FROM tickets WHERE id=?")
      .get(id) as any;
    if (!r) throw new Denied("Resource not found");
    const t = json(r.data);
    if (!this.visible(actor, t)) throw new Denied("Resource not found");
    return t;
  }
  tickets(actor: Actor): Ticket[] {
    return (this.db.prepare("SELECT data FROM tickets").all() as any[])
      .map((r) => json(r.data))
      .filter((t) => this.visible(actor, t))
      .sort(
        (a, b) =>
          ["urgent", "high", "normal", "low"].indexOf(a.priority) -
            ["urgent", "high", "normal", "low"].indexOf(b.priority) ||
          a.order - b.order,
      );
  }
  putTicket(t: Ticket) {
    this.assertWritable();
    this.db
      .prepare(
        "INSERT INTO tickets VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET handling=excluded.handling,data=excluded.data",
      )
      .run(t.id, t.handling, JSON.stringify(t));
  }
  conversation(id: string, actor: Actor): Conversation {
    const r = this.db
      .prepare("SELECT data FROM conversations WHERE id=?")
      .get(id) as any;
    if (!r) throw new Denied("Resource not found");
    const c = json(r.data);
    if (c.ticketId) this.ticket(c.ticketId, actor);
    else if (actor.kind === "worker") throw new Denied("Resource not found");
    return c;
  }
  putConversation(c: Conversation) {
    this.assertWritable();
    this.db
      .prepare(
        "INSERT INTO conversations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(c.id, c.ticketId ?? null, JSON.stringify(c));
  }
  conversations(actor: Actor) {
    return (this.db.prepare("SELECT data FROM conversations").all() as any[])
      .map((r) => json(r.data))
      .filter((c) => {
        try {
          this.conversation(c.id, actor);
          return true;
        } catch {
          return false;
        }
      });
  }
  putAttempt(a: Attempt) {
    this.assertWritable();
    this.db
      .prepare(
        "INSERT INTO attempts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(a.id, a.ticketId, a.conversationId, JSON.stringify(a));
  }
  attempts(id: string) {
    return (
      this.db
        .prepare("SELECT data FROM attempts WHERE ticket_id=?")
        .all(id) as any[]
    ).map((r) => json(r.data));
  }
  event(type: string, id: string, payload: unknown, ticketId?: string) {
    this.assertWritable();
    const eventId = randomUUID();
    const r = this.db
      .prepare(
        "INSERT INTO events(id,ticket_id,type,aggregate_id,payload,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(eventId, ticketId ?? null, type, id, JSON.stringify(payload), now());
    return Number(r.lastInsertRowid);
  }
  events(actor: Actor, after = 0) {
    const condition =
      actor.kind === "user"
        ? "1=1"
        : actor.kind === "worker"
          ? "t.handling='agent_managed' AND e.ticket_id=?"
          : "(e.ticket_id IS NULL OR t.handling='agent_managed')";
    const params =
      actor.kind === "worker" ? [after, actor.ticketId ?? ""] : [after];
    return (
      this.db
        .prepare(
          `SELECT e.* FROM events e LEFT JOIN tickets t ON t.id=e.ticket_id WHERE e.sequence>? AND ${condition} ORDER BY e.sequence LIMIT 1000`,
        )
        .all(...params) as any[]
    ).map((e) => ({
      schemaVersion: 1,
      sequence: e.sequence,
      eventId: e.id,
      type: e.type,
      aggregateId: e.aggregate_id,
      payload: json(e.payload),
      createdAt: e.created_at,
    }));
  }
  outbox(c: Command, kind: string, target: string, payload: unknown) {
    this.assertWritable();
    this.db
      .prepare(
        "INSERT INTO outbox(id,command_id,kind,target_id,payload,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        c.commandId,
        kind,
        target,
        JSON.stringify(payload),
        now(),
      );
  }
  command(actor: Actor, input: unknown): any {
    const c = commandSchema.parse(input);
    return this.db.transaction(() => {
      this.assertOwner();
      const old = this.db
        .prepare("SELECT * FROM commands WHERE id=?")
        .get(c.commandId) as any;
      if (old) {
        if (
          old.actor !== JSON.stringify(actor) ||
          old.request !== JSON.stringify(c)
        )
          throw new Conflict("Command identity reused with different input");
        return json(old.result);
      }
      const result = { commandId: c.commandId, ...this.apply(actor, c) };
      this.db
        .prepare("INSERT INTO commands VALUES(?,?,?,?,?)")
        .run(
          c.commandId,
          JSON.stringify(actor),
          JSON.stringify(c),
          JSON.stringify(result),
          now(),
        );
      this.event(
        "command.accepted",
        c.targetId ?? c.commandId,
        { commandId: c.commandId },
        result.ticketId,
      );
      return result;
    })();
  }
  apply(actor: Actor, c: Command): any {
    const p = c.payload;
    const user = () => {
      if (actor.kind !== "user") throw new Denied("Resource not found");
    };
    if (c.type === "ticket.create") {
      const v = z
        .object({
          title: z.string().trim().min(1).max(240),
          brief: z.string().max(100000).default(""),
          kind: z.enum(["change", "investigation"]).default("change"),
          handling: handling.default("agent_managed"),
          priority: priority.default("normal"),
          projectId: z.string().optional(),
          completionContract: z
            .enum(["merge", "report", "reviewed_draft"])
            .optional(),
          links: z
            .array(
              z.object({
                kind: z.enum(["github_pr", "linear_project", "linear_issue"]),
                url: z.string(),
              }),
            )
            .default([]),
        })
        .strict()
        .parse(p);
      if (v.handling === "human_only") user();
      if (actor.kind === "worker") throw new Denied("Resource not found");
      v.links.forEach(validateLink);
      const id = randomUUID();
      const t: Ticket = {
        ...v,
        id,
        slug:
          "FM-" +
          (Number(
            (this.db.prepare("SELECT count(*) n FROM tickets").get() as any).n,
          ) +
            1),
        order: Number(
          (
            this.db
              .prepare(
                "SELECT COALESCE(MAX(json_extract(data,'$.order')),0)+1 n FROM tickets",
              )
              .get() as any
          ).n,
        ),
        status: v.handling === "human_only" ? "backlog" : "queued",
        version: 1,
        completionContract:
          v.completionContract ??
          (v.kind === "investigation" ? "report" : "merge"),
        createdAt: now(),
        updatedAt: now(),
      };
      this.putTicket(t);
      this.event("ticket.created", id, t, id);
      if (t.handling === "agent_managed" && actor.id !== "migration")
        this.db
          .prepare("INSERT INTO wakes VALUES(?,?,?,?,?)")
          .run(
            "ticket:" + id,
            id,
            "pending",
            JSON.stringify({ kind: "ticket.created", ticketId: id }),
            now(),
          );
      return { ticketId: id, ticket: t };
    }
    if (c.type === "runtime.pause") {
      if (this.setting("shadowMode") && p.paused === false)
        throw new Conflict("Shadow mode cannot dispatch work");
      user();
      this.setting("policy", {
        ...this.setting("policy"),
        paused: z.boolean().parse(p.paused),
      });
      return { policy: this.setting("policy") };
    }
    if (c.type === "layout.save") {
      user();
      this.setting("layout", p);
      return { saved: true };
    }
    if (c.type === "conversation.create") {
      if (this.setting("shadowMode"))
        throw new Conflict("Shadow mode cannot create provider sessions");
      if (actor.kind !== "user" && actor.kind !== "supervisor")
        throw new Denied("Resource not found");
      const v = z
        .object({
          provider: z.enum(["codex", "claude"]),
          model: z.string().min(1),
          role: z.enum(["supervisor", "worker"]),
          ticketId: z.string().uuid().optional(),
        })
        .strict()
        .parse(p);
      if (v.role === "supervisor" && v.provider === "claude")
        throw new Conflict(
          "Claude supervisor requires verified native permission, interrupt, and resume controls",
        );
      if (v.role === "supervisor" && actor.kind !== "user")
        throw new Denied("Resource not found");
      if (v.role === "worker" && !v.ticketId)
        throw new Error("Worker requires a ticket");
      if (v.ticketId) {
        const t = this.ticket(v.ticketId, actor);
        this.assertManaged(t.id);
        if (t.handling === "human_only")
          throw new Conflict("Human only tickets cannot launch a conversation");
        for (const edge of this.db
          .prepare("SELECT requires_id FROM dependencies WHERE ticket_id=?")
          .all(t.id) as any[]) {
          const required = this.ticket(edge.requires_id, actor);
          const closure = this.db
            .prepare(
              "SELECT data FROM closures WHERE ticket_id=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(required.id) as any;
          if (
            required.status !== "completed" ||
            !closure ||
            json(closure.data).source !== "agent_detected"
          )
            throw new Conflict(
              "A required accepted deliverable is not complete",
            );
        }
      }
      if (
        v.role === "supervisor" &&
        this.conversations(actor).some(
          (x) => x.role === "supervisor" && !x.retiredAt,
        )
      )
        throw new Conflict("One Firstmate already exists");
      const project = this.setting("project");
      if (v.role === "worker" && !project?.source)
        throw new Conflict("Configure a project source first");
      const conv: Conversation = {
        ...v,
        id: randomUUID(),
        cwd:
          v.role === "supervisor"
            ? path.join(this.home, "workspace")
            : project.source,
        incarnation: 0,
        state: "planned",
        inputOwner: "automation",
        version: 1,
      };
      this.putConversation(conv);
      this.outbox(c, "conversation.launch", conv.id, {});
      return { conversation: conv, ticketId: v.ticketId };
    }
    if (c.type.startsWith("conversation.") || c.type === "permission.reply") {
      const conv = this.conversation(c.targetId!, actor);
      this.assertLeaseActive(conv.id);
      if (conv.ticketId) this.assertManaged(conv.ticketId);
      if (c.expectedVersion !== conv.version)
        throw new Conflict("Conversation changed; refresh before retrying");
      if (conv.retiredAt)
        throw new Conflict(
          "This chat is retained history. Use the current Firstmate chat.",
        );
      if (
        c.type === "conversation.model" ||
        c.type === "conversation.restart"
      ) {
        user();
        if (conv.state !== "idle")
          throw new Conflict(
            "Interrupt or resume the conversation and wait until idle first.",
          );
        if (
          this.db
            .prepare(
              "SELECT 1 FROM outbox WHERE target_id=? AND state IN ('pending','dispatching','uncertain')",
            )
            .get(conv.id)
        )
          throw new Conflict("Settle pending input before changing the chat.");
        if (c.type === "conversation.model") {
          if (conv.provider !== "codex")
            throw new Conflict("Model switching currently requires Codex.");
          this.requireCurrentRunner(conv, p.effort ? 3 : 2);
          if (p.effort) {
            const model = (this.setting("modelCatalog") ?? []).find(
              (m: any) => m.model === p.model,
            );
            if (
              !model?.supportedReasoningEfforts.some(
                (e: any) => e.reasoningEffort === p.effort,
              )
            )
              throw new Conflict("Unsupported thinking effort for this model.");
          }
          conv.effort = p.effort
            ? z.string().max(40).parse(p.effort)
            : undefined;
          conv.model = z.string().min(1).max(128).parse(p.model);
        } else {
          if (conv.role !== "supervisor")
            throw new Conflict("New chat is available for Firstmate only.");
          conv.retiredAt = now();
          conv.inputOwner = actor.id;
          this.outbox(c, "conversation.park", conv.id, {});
          const next: Conversation = {
            id: randomUUID(),
            provider: conv.provider,
            model: conv.model,
            effort: conv.effort,
            role: "supervisor",
            cwd: conv.cwd,
            incarnation: 0,
            state: "planned",
            inputOwner: actor.id,
            version: 1,
            previousConversationId: conv.id,
          };
          this.putConversation(next);
          this.outbox(c, "conversation.launch", next.id, {});
        }
      } else if (c.type === "conversation.attach") {
        user();
        const name = z.string().min(1).max(160).parse(p.name);
        const media = z
          .enum([
            "text/plain",
            "application/json",
            "image/png",
            "image/jpeg",
            "image/webp",
          ])
          .parse(p.mediaType);
        if (conv.provider === "claude" && media.startsWith("image/"))
          throw new Conflict("Claude image attachments are not yet verified");
        const content = Buffer.from(
          z.string().max(750000).parse(p.base64),
          "base64",
        );
        if (!content.length || content.length > 512 * 1024)
          throw new Conflict("Attachment limit is 512 KiB");
        const id = this.artifact(conv.ticketId, name, content, media, conv.id);
        this.event(
          "conversation.attachment",
          conv.id,
          { id, name },
          conv.ticketId,
        );
        return {
          attachment: { id, name, mediaType: media },
          conversation: conv,
        };
      } else if (
        c.type === "conversation.send" ||
        c.type === "conversation.steer"
      ) {
        if (
          conv.ticketId &&
          conv.stage !== "review" &&
          this.setting("writerReservation:" + conv.ticketId)
        )
          throw new Conflict(
            "Draft publication owns this writer until it settles",
          );
        if (conv.inputOwner !== "automation" && actor.kind !== "user")
          throw new Conflict("User takeover retains input ownership");
        const text = z.string().min(1).max(100000).parse(p.text);
        if (["lost", "uncertain"].includes(conv.state))
          throw new Conflict(
            "Reconcile uncertain delivery before sending again",
          );
        if (
          c.type.endsWith("steer") &&
          (conv.provider !== "codex" || conv.state !== "running")
        )
          throw new Conflict("Steering requires an active Codex turn");
        const attachments = z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .max(4)
          .parse(p.attachments ?? []);
        for (const id of attachments)
          if (
            !this.db
              .prepare(
                "SELECT 1 FROM artifact_access WHERE artifact_id=? AND conversation_id=?",
              )
              .get(id, conv.id)
          )
            throw new Denied("Attachment not found");
        const mid = randomUUID();
        this.message(conv.id, mid, "user", text, "message");
        for (const id of attachments)
          this.db
            .prepare("INSERT OR IGNORE INTO message_attachments VALUES(?,?)")
            .run(mid, id);
        const skills = z
          .array(z.object({ name: z.string(), path: z.string() }))
          .max(4)
          .parse(p.skills ?? []);
        if (skills.length && conv.provider !== "codex")
          throw new Conflict("Explicit skill input currently requires Codex.");
        if (skills.length) this.requireCurrentRunner(conv);
        const available = this.setting("skills:" + conv.id) ?? [];
        for (const skill of skills)
          if (
            !available.some(
              (s: any) =>
                s.enabled && s.path === skill.path && s.name === skill.name,
            )
          )
            throw new Denied(
              "Skill is not available for this session; refresh the Skills tab.",
            );
        this.outbox(c, c.type, conv.id, {
          text,
          messageId: mid,
          attachments,
          skills,
        });
      } else if (c.type === "conversation.interrupt") {
        this.outbox(c, c.type, conv.id, {});
      } else if (c.type === "conversation.takeover") {
        user();
        conv.inputOwner = actor.id;
        this.outbox(c, "conversation.interrupt", conv.id, {});
      } else if (c.type === "conversation.return") {
        user();
        conv.inputOwner = "automation";
      } else if (c.type === "conversation.park") {
        user();
        if (conv.state !== "idle")
          throw new Conflict("Settle the active turn before parking");
        conv.inputOwner = actor.id;
        this.outbox(c, c.type, conv.id, {});
      } else if (c.type === "conversation.resume") {
        user();
        if (!["lost", "interrupted", "failed"].includes(conv.state))
          throw new Conflict("Conversation does not need resume");
        this.outbox(c, "conversation.resume", conv.id, {});
      } else if (c.type === "permission.reply") {
        user();
        const req = this.db
          .prepare("SELECT * FROM permissions WHERE id=? AND conversation_id=?")
          .get(z.string().parse(p.requestId), conv.id) as any;
        if (!req || req.state !== "pending")
          throw new Conflict("Permission request expired");
        const data = json(req.data);
        if (data.incarnation !== conv.incarnation)
          throw new Conflict("Permission incarnation changed");
        this.outbox(c, c.type, conv.id, {
          requestId: req.id,
          decision: z.enum(["accept", "decline"]).parse(p.decision),
          provenance: data,
        });
        this.db
          .prepare("UPDATE permissions SET state='answering' WHERE id=?")
          .run(req.id);
      } else throw new Error("Unknown command");
      conv.version++;
      this.putConversation(conv);
      this.event("conversation.updated", conv.id, conv, conv.ticketId);
      return { conversation: conv, ticketId: conv.ticketId };
    }
    if (c.type === "wake.ack") {
      if (actor.kind !== "supervisor") throw new Denied("Resource not found");
      const wid = z.string().parse(p.id);
      const wake = this.db
        .prepare("SELECT ticket_id FROM wakes WHERE id=?")
        .get(wid) as any;
      if (!wake) throw new Denied("Resource not found");
      if (wake.ticket_id) this.ticket(wake.ticket_id, actor);
      this.db.prepare("UPDATE wakes SET state='handled' WHERE id=?").run(wid);
      return { handled: true };
    }
    const t = this.ticket(c.targetId!, actor);
    if (c.expectedVersion !== t.version)
      throw new Conflict("Ticket changed; refresh before retrying");
    if (
      [
        "ticket.revision",
        "ticket.claimComplete",
        "stage.retry",
        "ticket.review",
        "ticket.refreshPr",
        "ticket.repair",
        "ticket.draftPr",
      ].includes(c.type) &&
      (t.handling === "human_only" ||
        ["completed", "cancelled"].includes(t.status))
    )
      throw new Conflict("Ticket is not eligible for managed execution");
    if (
      this.externallyManaged(t.id) &&
      ![
        "ticket.adopt",
        "ticket.update",
        "ticket.complete",
        "ticket.cancel",
        "ticket.reopen",
        "ticket.dependencies",
      ].includes(c.type)
    )
      this.assertManaged(t.id);
    if (this.externallyManaged(t.id)) user();
    if (c.type === "ticket.adopt") {
      user();
      const eligibility = this.adoptionEligibility(t);
      if (!eligibility.eligible) throw new Conflict(eligibility.reason);
      const legacy = this.setting("legacy:" + t.id);
      this.setting("legacy:" + t.id, {
        ...legacy,
        management: "app",
        adoptedAt: now(),
        adoptedBy: actor.id,
      });
      t.status = "queued";
      this.db
        .prepare("INSERT INTO wakes VALUES(?,?,?,?,?)")
        .run(
          "adopt:" + c.commandId,
          t.id,
          "pending",
          JSON.stringify({ kind: "ticket.adopted", ticketId: t.id }),
          now(),
        );
    } else if (c.type === "ticket.dependencies") {
      if (actor.kind === "worker") throw new Denied("Resource not found");
      const ids = z.array(z.string().uuid()).parse(p.requires);
      for (const id of ids) {
        const dep = this.ticket(id, actor);
        if (dep.handling !== t.handling)
          throw new Conflict(
            "Dependencies cannot cross the Human only boundary",
          );
        const visit = (current: string, seen = new Set<string>()): boolean => {
          if (current === t.id) return true;
          if (seen.has(current)) return false;
          seen.add(current);
          return (
            this.db
              .prepare("SELECT requires_id FROM dependencies WHERE ticket_id=?")
              .all(current) as any[]
          ).some((e) => visit(e.requires_id, seen));
        };
        if (visit(id)) throw new Conflict("Dependency cycle");
      }
      this.db.prepare("DELETE FROM dependencies WHERE ticket_id=?").run(t.id);
      for (const id of new Set(ids))
        this.db
          .prepare("INSERT INTO dependencies VALUES(?,?,?)")
          .run(t.id, id, "accepted_deliverable");
    } else if (c.type === "ticket.validate") {
      if (actor.kind !== "user" && actor.kind !== "supervisor")
        throw new Denied("Resource not found");
      if (
        t.handling === "human_only" ||
        ["completed", "cancelled"].includes(t.status)
      )
        throw new Conflict("Ticket cannot run checks");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM outbox WHERE target_id=? AND kind='ticket.validate' AND state IN ('pending','dispatching','uncertain')",
          )
          .get(t.id)
      )
        throw new Conflict("Check dispatch already reserved");
      this.outbox(c, "ticket.validate", t.id, {});
    } else if (c.type === "ticket.review") {
      if (actor.kind !== "user" && actor.kind !== "supervisor")
        throw new Denied("Resource not found");
      if (!t.revision || !this.setting("revision:" + t.revision))
        throw new Conflict("Freeze a Git revision first");
      if (
        this.conversations(actor).some(
          (x) =>
            x.ticketId === t.id &&
            x.stage === "review" &&
            !["idle", "failed", "lost", "interrupted"].includes(x.state),
        )
      )
        throw new Conflict("An independent review is already active");
      const project = this.setting("project");
      const conv: Conversation = {
        id: randomUUID(),
        ticketId: t.id,
        provider: z.literal("codex").parse(p.provider ?? "codex"),
        model: z.string().parse(p.model ?? "gpt-5.6-sol"),
        role: "worker",
        stage: "review",
        reviewRevision: t.revision,
        cwd: project.source,
        incarnation: 0,
        state: "planned",
        inputOwner: "automation",
        version: 1,
      };
      this.putConversation(conv);
      this.outbox(c, "conversation.launch", conv.id, {});
      this.outbox(c, "conversation.send", conv.id, {
        text:
          "Independently review this exact frozen revision " +
          JSON.stringify(this.setting("revision:" + t.revision)) +
          ". Read the scoped ticket detail for prior findings. Inspect code and tests, do not edit. Report JSON matching the review schema. Focus on concrete correctness risks. Brief: " +
          t.brief,
        messageId: randomUUID(),
      });
    } else if (c.type === "ticket.draftPr") {
      if (
        actor.kind !== "user" &&
        !(
          actor.kind === "supervisor" && this.setting("project")?.draftPrEnabled
        )
      )
        throw new Denied(
          "Draft creation requires an explicit user action or project authorization",
        );
      if (this.setting("writerReservation:" + t.id))
        throw new Conflict("This ticket already has a reserved writer");
      const source = this.setting("revision-source:" + t.revision);
      if (!source)
        throw new Conflict("Freeze and validate a source revision first");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM outbox WHERE target_id=? AND state IN ('pending','dispatching','uncertain')",
          )
          .get(source.conversationId)
      )
        throw new Conflict("Settle pending worker input before publication");
      const title = z.string().min(1).max(240).parse(p.title);
      const body = z.string().min(20).max(100000).parse(p.body);
      this.setting("writerReservation:" + t.id, {
        commandId: c.commandId,
        kind: "draft",
      });
      this.outbox(c, c.type, t.id, { title, body });
    } else if (c.type === "ticket.repair") {
      if (actor.kind !== "user" && actor.kind !== "supervisor")
        throw new Denied("Resource not found");
      if (!t.revision || !this.setting("revision:" + t.revision))
        throw new Conflict("Freeze a revision before repair");
      const conversations = this.conversations(actor).filter(
        (x) => x.ticketId === t.id,
      );
      if (
        conversations.some(
          (x) =>
            x.stage !== "review" &&
            ["planned", "starting", "running", "waiting_permission"].includes(
              x.state,
            ),
        )
      )
        throw new Conflict("An existing writer must settle before repair");
      if (
        conversations.filter((x) => x.stage === "repair").length >=
        this.setting("policy").retry.repairCycles
      )
        throw new Conflict(
          "Repair cycle budget exhausted; user decision required",
        );
      const findings = (
        this.db
          .prepare("SELECT id,data FROM findings WHERE ticket_id=?")
          .all(t.id) as any[]
      )
        .map((r) => ({ id: r.id, ...json(r.data) }))
        .filter((f) => f.status !== "resolved");
      if (!findings.length) throw new Conflict("No open findings to repair");
      const conv: Conversation = {
        id: randomUUID(),
        ticketId: t.id,
        provider: "codex",
        model: z.string().parse(p.model ?? "gpt-5.6-sol"),
        role: "worker",
        stage: "repair",
        baseRevision: t.revision,
        cwd: this.setting("project").source,
        incarnation: 0,
        state: "planned",
        inputOwner: "automation",
        version: 1,
      };
      this.putConversation(conv);
      this.outbox(c, "conversation.launch", conv.id, {});
      this.outbox(c, "conversation.send", conv.id, {
        text:
          "Repair the verified findings in this isolated checkout. Preserve project instructions. Commit a coherent fix, run focused tests, and report evidence. Do not mark findings resolved yourself, create a PR, merge, or request reviewers. Brief: " +
          t.brief +
          " Findings: " +
          JSON.stringify(findings),
        messageId: randomUUID(),
      });
    } else if (c.type === "ticket.refreshPr") {
      if (actor.kind === "worker") throw new Denied("Resource not found");
      this.outbox(c, "ticket.refreshPr", t.id, {});
    } else if (c.type === "ticket.update") {
      const v = z
        .object({
          title: z.string().min(1).max(240).optional(),
          brief: z.string().max(100000).optional(),
          priority: priority.optional(),
          links: z
            .array(z.object({ kind: z.string(), url: z.string() }))
            .optional(),
          handling: handling.optional(),
        })
        .strict()
        .parse(p);
      v.links?.forEach(validateLink);
      if (v.handling && v.handling !== t.handling) {
        user();
        if (
          this.db
            .prepare(
              "SELECT 1 FROM dependencies WHERE ticket_id=? OR requires_id=?",
            )
            .get(t.id, t.id)
        )
          throw new Conflict("Remove dependencies before changing handling");
        this.suppress(t, c);
        if (
          this.attempts(t.id).some((a) =>
            ["planned", "starting", "running", "waiting_permission"].includes(
              a.state,
            ),
          )
        )
          throw new Conflict("Settle active attempts before changing handling");
        if (
          this.conversations(actor).some(
            (x) =>
              x.ticketId === t.id &&
              ["running", "starting", "uncertain"].includes(x.state),
          )
        )
          throw new Conflict(
            "Settle active conversations before changing handling",
          );
      }
      if (v.brief !== undefined && v.brief !== t.brief) {
        t.revision = undefined;
        if (!["completed", "cancelled"].includes(t.status)) t.status = "queued";
        this.db
          .prepare(
            "UPDATE retries SET state='obsolete' WHERE ticket_id=? AND state='scheduled'",
          )
          .run(t.id);
      }
      Object.assign(t, v);
    } else if (c.type === "ticket.complete") {
      user();
      this.close(t, "manual", actor.id, z.string().optional().parse(p.note), c);
    } else if (c.type === "ticket.deliverReport") {
      if (
        t.kind !== "investigation" ||
        t.handling === "human_only" ||
        ["completed", "cancelled"].includes(t.status)
      )
        throw new Conflict("Ticket cannot accept a report");
      const text = z.string().min(20).max(1000000).parse(p.text);
      const artifactId = this.artifact(
        t.id,
        "investigation-report.md",
        text,
        "text/markdown",
      );
      const revision = createHash("sha256")
        .update(JSON.stringify({ artifactId, brief: t.brief }))
        .digest("hex");
      t.revision = revision;
      this.db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?,?)").run(
        randomUUID(),
        t.id,
        revision,
        "report",
        "passed",
        JSON.stringify({
          artifactId,
          provenance: "content-addressed report collector",
          brief: t.brief,
        }),
        now(),
      );
      this.evaluate(t, false);
    } else if (c.type === "ticket.claimComplete") {
      if (t.handling === "human_only") throw new Denied("Resource not found");
      this.evaluate(t, true);
      this.close(
        t,
        "agent_detected",
        actor.id,
        z.string().parse(p.rationale),
        c,
      );
    } else if (c.type === "ticket.reopen") {
      user();
      if (t.status !== "completed")
        throw new Conflict("Only completed tickets can reopen");
      t.status = t.handling === "human_only" ? "backlog" : "queued";
    } else if (c.type === "ticket.cancel") {
      user();
      t.status = "cancelled";
      this.suppress(t, c);
    } else if (c.type === "ticket.revision") {
      if (actor.kind !== "collector" && actor.kind !== "user")
        throw new Denied("Resource not found");
      t.revision = z.string().min(1).parse(p.revision);
      t.status = "active";
      this.db
        .prepare(
          "UPDATE retries SET state='obsolete' WHERE ticket_id=? AND state='scheduled'",
        )
        .run(t.id);
    } else if (c.type === "evidence.register") {
      if (actor.kind !== "collector")
        throw new Denied("Only a verified collector can register evidence");
      const v = z
        .object({
          revision: z.string(),
          requirement: z.string(),
          verdict: z.enum(["passed", "failed", "unknown", "not_applicable"]),
          provenance: z.string().min(1),
          artifactId: z.string().optional(),
        })
        .strict()
        .parse(p);
      this.db
        .prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          t.id,
          v.revision,
          v.requirement,
          v.verdict,
          JSON.stringify(v),
          now(),
        );
      this.evaluate(t, false);
    } else if (c.type === "stage.retry") {
      if (actor.kind !== "user" && actor.kind !== "collector")
        throw new Denied("Resource not found");
      if (
        ["completed", "cancelled"].includes(t.status) ||
        t.handling === "human_only"
      )
        throw new Conflict("Ticket is not eligible for retries");
      const stage = z.string().parse(p.stage);
      if (
        this.db
          .prepare(
            "SELECT 1 FROM outbox WHERE kind='stage.retry' AND target_id=? AND state IN ('pending','dispatching','uncertain')",
          )
          .get(t.id)
      )
        throw new Conflict("A retry is already reserved or uncertain");
      const attempts = this.attempts(t.id).filter((a) => a.role === stage);
      if (
        attempts.some((a) =>
          ["starting", "running", "planned", "waiting_permission"].includes(
            a.state,
          ),
        )
      )
        throw new Conflict("Stage still has an active attempt");
      if (
        !attempts.length ||
        !["failed", "interrupted"].includes(attempts.at(-1).state)
      )
        throw new Conflict("No failed or interrupted stage to retry");
      const oldConversation = this.conversation(
        attempts.at(-1).conversationId,
        actor,
      );
      if (oldConversation.inputOwner !== "automation")
        throw new Conflict("User takeover blocks retries");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM outbox WHERE target_id=? AND state IN ('dispatching','uncertain')",
          )
          .get(oldConversation.id)
      )
        throw new Conflict("Reconcile ambiguous effects before retrying");
      if (
        actor.kind === "collector" &&
        attempts.filter((a) => a.revision === t.revision).length >= 3
      )
        throw new Conflict("Automatic retry budget exhausted");
      this.db
        .prepare(
          "UPDATE retries SET state='cancelled' WHERE ticket_id=? AND stage=? AND state='scheduled'",
        )
        .run(t.id, stage);
      this.outbox(c, "stage.retry", t.id, {
        stage,
        revision: t.revision,
        parentId: attempts.at(-1).id,
      });
    } else throw new Error("Unknown command");
    t.version++;
    t.updatedAt = now();
    this.putTicket(t);
    this.event("ticket.updated", t.id, t, t.id);
    return { ticketId: t.id, ticket: t };
  }
  suppress(t: Ticket, command: Command) {
    this.db
      .prepare(
        "UPDATE outbox SET state='cancelled' WHERE target_id=? AND state='pending'",
      )
      .run(t.id);
    this.db
      .prepare(
        "UPDATE retries SET state='cancelled' WHERE ticket_id=? AND state='scheduled'",
      )
      .run(t.id);
    this.db
      .prepare(
        "UPDATE wakes SET state='cancelled' WHERE ticket_id=? AND state!='handled'",
      )
      .run(t.id);
    for (const c of this.conversations({ kind: "user", id: "runtime" }).filter(
      (c) => c.ticketId === t.id,
    )) {
      this.db
        .prepare(
          "UPDATE outbox SET state='cancelled' WHERE target_id=? AND state='pending'",
        )
        .run(c.id);
      if (["running", "waiting_permission"].includes(c.state))
        this.outbox(command, "conversation.interrupt", c.id, {});
      for (const attempt of this.attempts(t.id).filter(
        (a) =>
          a.conversationId === c.id &&
          ["planned", "starting"].includes(a.state),
      )) {
        attempt.state = "cancelled";
        attempt.endedAt = now();
        this.putAttempt(attempt);
      }
    }
  }
  close(
    t: Ticket,
    source: string,
    actor: string,
    note: string | undefined,
    command: Command,
  ) {
    if (t.status === "completed") return;
    t.status = "completed";
    this.suppress(t, command);
    this.db.prepare("INSERT INTO closures VALUES(?,?,?)").run(
      randomUUID(),
      t.id,
      JSON.stringify({
        source,
        actor,
        note,
        revision: t.revision,
        criterionVersion: 1,
        completedAt: now(),
        evidence: this.evidence(t.id),
      }),
    );
  }
  evidence(id: string) {
    return (
      this.db
        .prepare("SELECT * FROM evidence WHERE ticket_id=? ORDER BY created_at")
        .all(id) as any[]
    ).map((e) => ({ ...e, data: json(e.data) }));
  }
  evaluate(t: Ticket, requireComplete: boolean) {
    const source = this.setting("revision-source:" + t.revision);
    const facts = this.setting("revision:" + t.revision);
    let sourceCurrent = true;
    if (source && facts) {
      try {
        sourceCurrent =
          !git(source.cwd, ["status", "--porcelain"]) &&
          git(source.cwd, ["rev-parse", "HEAD"]) === facts.head &&
          (git(source.cwd, ["rev-parse", "origin/main"]) === facts.base ||
            (t.links.some((l) => l.kind === "github_pr") &&
              t.links
                .filter((l) => l.kind === "github_pr")
                .every(
                  (l) =>
                    this.setting("verified-merge:" + l.url)?.revision ===
                    t.revision,
                )));
      } catch {
        sourceCurrent = false;
      }
    }
    const prs = t.links.filter((l) => l.kind === "github_pr");
    const required =
      t.kind === "investigation"
        ? ["report"]
        : [
            "validation",
            "review",
            ...(prs.length ? prs.map((l) => "ci:" + l.url) : ["ci"]),
          ];
    if (requireComplete && t.completionContract === "merge")
      required.push(
        ...(prs.length ? prs.map((l) => "merge:" + l.url) : ["merge"]),
      );
    const ev = this.evidence(t.id);
    const blocking = (
      this.db
        .prepare("SELECT data FROM findings WHERE ticket_id=?")
        .all(t.id) as any[]
    ).some((r) => {
      const f = json(r.data);
      return f.status !== "resolved" && f.severity === "blocking";
    });
    const passed =
      sourceCurrent &&
      !blocking &&
      !prs.some(
        (l) =>
          this.setting("remote-drift:" + t.id + ":" + l.url)?.revision ===
          t.revision,
      ) &&
      !!t.revision &&
      required.every((r) => {
        const latest = ev
          .filter((e) => e.revision === t.revision && e.requirement === r)
          .at(-1);
        return latest?.verdict === "passed";
      });
    if (requireComplete && !passed)
      throw new Conflict("Current revision lacks required verified evidence");
    if (!["completed", "cancelled"].includes(t.status))
      t.status = passed ? "awaiting_decision" : "active";
  }
  message(
    cid: string,
    id: string,
    role: string,
    content: string,
    kind: string,
    providerId?: string,
  ) {
    this.assertWritable();
    this.db
      .prepare(
        `INSERT INTO messages(id,conversation_id,role,content,kind,provider_id,sequence,created_at) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?),?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,version=messages.version+1`,
      )
      .run(id, cid, role, content, kind, providerId ?? null, cid, now());
  }
  messages(cid: string, before = Number.MAX_SAFE_INTEGER, limit = 100) {
    return (
      this.db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
        )
        .all(cid, before, Math.min(limit, 500)) as any[]
    )
      .reverse()
      .map((message) => ({
        ...message,
        attachments: this.db
          .prepare(
            "SELECT a.id,a.name,a.media_type FROM artifacts a JOIN message_attachments ma ON ma.artifact_id=a.id WHERE ma.message_id=?",
          )
          .all(message.id),
      }));
  }
  detail(id: string, actor: Actor) {
    const ticket = this.ticket(id, actor);
    return {
      ticket,
      attempts: this.attempts(id),
      findings: (
        this.db
          .prepare("SELECT id,data FROM findings WHERE ticket_id=?")
          .all(id) as any[]
      ).map((r) => ({ id: r.id, ...json(r.data) })),
      legacy: this.setting("legacy:" + id),
      adoption:
        actor.kind === "user" ? this.adoptionEligibility(ticket) : undefined,
      evidence: this.evidence(id),
      revisionFacts: this.setting("revision:" + ticket.revision),
      ciConfiguration: {
        requiredChecks: this.setting("project")?.requiredChecks ?? [],
        configured: !!this.setting("project")?.requiredChecks?.length,
      },
      dependencies: this.db
        .prepare(
          "SELECT requires_id,criterion FROM dependencies WHERE ticket_id=?",
        )
        .all(id),
      closures: (
        this.db
          .prepare("SELECT data FROM closures WHERE ticket_id=?")
          .all(id) as any[]
      ).map((r) => json(r.data)),
      retries: this.db
        .prepare("SELECT * FROM retries WHERE ticket_id=?")
        .all(id),
    };
  }
  artifact(
    ticketId: string | undefined,
    name: string,
    content: string | Buffer,
    media = "text/plain",
    conversationId?: string,
  ) {
    this.assertWritable();
    const id = createHash("sha256").update(content).digest("hex");
    const dir = path.join(this.home, "app", "objects");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomic(path.join(dir, id), content);
    this.db
      .prepare("INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?)")
      .run(id, ticketId ?? null, media, Buffer.byteLength(content), name);
    if (conversationId)
      this.db
        .prepare("INSERT OR IGNORE INTO artifact_access VALUES(?,?)")
        .run(id, conversationId);
    return id;
  }
  usage(actor: Actor) {
    return (this.db.prepare("SELECT * FROM usage").all() as any[])
      .filter((r) => {
        try {
          this.conversation(r.conversation_id, actor);
          return true;
        } catch {
          return false;
        }
      })
      .map((r) => ({ ...r, data: json(r.data) }));
  }
  backup(destination: string) {
    return this.db.backup(destination);
  }
}
function validateLink(link: { kind: string; url: string }) {
  const u = new URL(link.url);
  if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("Links must use HTTPS without credentials");
  if (
    link.kind === "github_pr" &&
    !(
      u.hostname === "github.com" &&
      /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(u.pathname)
    )
  )
    throw new Error("Use a GitHub pull request URL");
  if (link.kind.startsWith("linear_") && u.hostname !== "linear.app")
    throw new Error("Use a Linear URL");
  if (!["github_pr", "linear_project", "linear_issue"].includes(link.kind))
    throw new Error("Unsupported link kind");
}
