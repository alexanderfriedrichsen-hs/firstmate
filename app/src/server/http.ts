import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import type { Actor } from "../contracts.ts";
import { capabilities } from "../contracts.ts";
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function serve(store: Store, port: number) {
  const session = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const origin = `http://127.0.0.1:${port}`;
  const clients = new Set<http.ServerResponse>();
  const server = http.createServer(async (req, res) => {
    const send = (status: number, data: any) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.host !== `127.0.0.1:${port}`)
        return send(403, { error: "Invalid Host" });
      if (req.headers.origin && req.headers.origin !== origin)
        return send(403, { error: "Invalid Origin" });
      const u = new URL(req.url!, origin);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (u.pathname === "/v1/session" && req.method === "GET") {
        if (req.headers.authorization)
          return send(403, {
            error: "Agent credentials cannot create operator sessions",
          });
        if (
          req.headers["sec-fetch-site"] &&
          req.headers["sec-fetch-site"] !== "same-origin"
        )
          return send(403, { error: "Open the local app first" });
        res.setHeader(
          "Set-Cookie",
          `fm_session=${session}; HttpOnly; SameSite=Strict; Path=/`,
        );
        return send(200, { csrf });
      }
      if (!u.pathname.startsWith("/v1/")) {
        if (req.method !== "GET")
          return send(405, { error: "Method not allowed" });
        const root = fileURLToPath(new URL("../../dist/", import.meta.url));
        const asset = u.pathname.startsWith("/assets/")
          ? path.join(root, u.pathname)
          : path.join(root, "index.html");
        if (!asset.startsWith(root) || !fs.existsSync(asset))
          return send(404, { error: "Run npm run build first" });
        res.setHeader(
          "Content-Type",
          asset.endsWith(".js")
            ? "text/javascript"
            : asset.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        return fs.createReadStream(asset).pipe(res);
      }
      let actor: Actor = { kind: "user", id: "operator" };
      const bearer = req.headers.authorization?.replace(/^Bearer /, "");
      if (bearer) {
        const tokens = store.setting("agentTokens") ?? [];
        const auth = tokens.find((t: any) => equal(t.token, bearer));
        if (!auth) return send(401, { error: "Invalid agent credential" });
        actor = auth.actor;
      } else if (
        !req.headers.cookie
          ?.split("; ")
          .some((c) => c === `fm_session=${session}`)
      )
        return send(401, { error: "Open a local browser session" });
      if (req.method === "POST") {
        if (
          actor.kind === "user" &&
          (!equal(String(req.headers["x-csrf-token"] ?? ""), csrf) ||
            req.headers.origin !== origin)
        )
          return send(403, { error: "Invalid mutation session" });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 1024 * 1024)
            return send(413, { error: "Request too large" });
        }
        if (u.pathname === "/v1/commands") {
          const result = store.command(actor, JSON.parse(body));
          return send(202, {
            ...result,
            statusUrl: "/v1/commands/" + result.commandId,
          });
        }
        return send(404, { error: "Unknown endpoint" });
      }
      if (req.method !== "GET")
        return send(405, { error: "Method not allowed" });
      const commandStatus = u.pathname.match(/^\/v1\/commands\/([a-f0-9-]+)$/);
      if (commandStatus) {
        const row = store.db
          .prepare("SELECT actor,result FROM commands WHERE id=?")
          .get(commandStatus[1]) as any;
        if (
          !row ||
          (actor.kind !== "user" && row.actor !== JSON.stringify(actor))
        )
          return send(404, { error: "Resource not found" });
        return send(200, {
          ...JSON.parse(row.result),
          effects: store.db
            .prepare("SELECT id,kind,state FROM outbox WHERE command_id=?")
            .all(commandStatus[1]),
        });
      }
      if (u.pathname === "/v1/snapshot")
        return send(200, {
          tickets: store.tickets(actor),
          conversations: store.conversations(actor),
          policy: store.setting("policy"),
          legacyExternalChanges:
            actor.kind === "user"
              ? store.setting("legacyExternalChanges")
              : undefined,
          layout: actor.kind === "user" ? store.setting("layout") : undefined,
          capabilities,
          project: store.setting("project")
            ? {
                remote: store.setting("project").remote,
                requiredChecks: store.setting("project").requiredChecks ?? [],
              }
            : undefined,
          sequence: (
            store.db
              .prepare("SELECT COALESCE(MAX(sequence),0) n FROM events")
              .get() as any
          ).n,
          runtimeError: store.setting("runtimeError"),
        });
      if (u.pathname === "/v1/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        let cursor = Number(u.searchParams.get("after") ?? 0);
        const pump = () => {
          const rows = store.events(actor, cursor);
          for (const e of rows) {
            res.write(`id: ${e.sequence}\ndata: ${JSON.stringify(e)}\n\n`);
            cursor = e.sequence;
          }
          res.write(": keepalive\n\n");
        };
        pump();
        const timer = setInterval(pump, 1000);
        clients.add(res);
        req.on("close", () => {
          clearInterval(timer);
          clients.delete(res);
        });
        return;
      }
      if (u.pathname === "/v1/usage")
        return send(200, {
          observations: store.usage(actor),
          accountAllowance: null,
        });
      if (u.pathname === "/v1/wakes") {
        const wakes = store.db
          .prepare("SELECT * FROM wakes WHERE state='pending'")
          .all() as any[];
        return send(
          200,
          wakes.filter((w) => {
            try {
              return !w.ticket_id || !!store.ticket(w.ticket_id, actor);
            } catch {
              return false;
            }
          }),
        );
      }
      const ticket = u.pathname.match(/^\/v1\/tickets\/([^/]+)$/);
      if (ticket) return send(200, store.detail(ticket[1], actor));
      const conversation = u.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
      if (conversation) {
        const c = store.conversation(conversation[1], actor);
        const messageId = u.searchParams.get("message");
        const anchor = messageId
          ? (store.db
              .prepare(
                "SELECT sequence FROM messages WHERE id=? AND conversation_id=?",
              )
              .get(messageId, c.id) as { sequence: number } | undefined)
          : undefined;
        if (messageId && !anchor)
          return send(404, { error: "Message not found" });
        return send(200, {
          conversation: c,
          messages: u.searchParams.get("search")
            ? store.db
                .prepare(
                  "SELECT * FROM messages WHERE conversation_id=? AND instr(lower(content),lower(?))>0 ORDER BY sequence DESC LIMIT 100",
                )
                .all(c.id, u.searchParams.get("search"))
                .reverse()
            : store.messages(
                c.id,
                anchor
                  ? anchor.sequence + 1
                  : Number(
                      u.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
                    ),
              ),
          permissions: (
            store.db
              .prepare("SELECT * FROM permissions WHERE conversation_id=?")
              .all(c.id) as any[]
          ).map((p) => ({ ...p, data: JSON.parse(p.data) })),
        });
      }
      const artifact = u.pathname.match(/^\/v1\/artifacts\/([a-f0-9]{64})$/);
      if (artifact) {
        const a = store.db
          .prepare("SELECT * FROM artifacts WHERE id=?")
          .get(artifact[1]) as any;
        if (!a) return send(404, { error: "Resource not found" });
        if (a.ticket_id) store.ticket(a.ticket_id, actor);
        else if (actor.kind !== "user") {
          const access = store.db
            .prepare(
              "SELECT conversation_id FROM artifact_access WHERE artifact_id=?",
            )
            .all(a.id) as any[];
          if (
            !access.some((row) => {
              try {
                store.conversation(row.conversation_id, actor);
                return true;
              } catch {
                return false;
              }
            })
          )
            return send(404, { error: "Resource not found" });
        }
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", "inline");
        return fs
          .createReadStream(path.join(store.home, "app", "objects", a.id))
          .pipe(res);
      }
      return send(404, { error: "Resource not found" });
    } catch (error: any) {
      send(error.status ?? 400, { error: error.message ?? String(error) });
    }
  });
  return {
    server,
    start: () =>
      new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)),
    close: () => {
      for (const c of clients) c.end();
      server.close();
    },
  };
}
