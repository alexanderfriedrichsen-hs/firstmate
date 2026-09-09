import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.ts";
import type { Conversation } from "../contracts.ts";
import { now } from "../contracts.ts";

export function recordContext(
  store: Store,
  c: Conversation,
  name: string,
  content: string,
  source: string,
  filePath?: string,
) {
  const artifactId = store.artifact(
    c.ticketId,
    name,
    content,
    "text/markdown",
    c.id,
  );
  const key = "context:" + c.id;
  const rows = store.setting(key) ?? [];
  if (
    !rows.some(
      (r: any) =>
        r.artifactId === artifactId && r.incarnation === c.incarnation,
    )
  )
    store.setting(key, [
      ...rows,
      {
        name,
        path: filePath,
        artifactId,
        source,
        incarnation: c.incarnation,
        recordedAt: now(),
      },
    ]);
  return artifactId;
}
export function collectOutputs(store: Store, c: Conversation) {
  const root = path.join(c.cwd, "outputs");
  const types: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".json": "application/json",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".svg": "image/svg+xml",
  };
  let count = 0;
  const seen = new Set<string>();
  const cwd = fs.realpathSync(c.cwd);
  const capture = (file: string) => {
    const media = types[path.extname(file).toLowerCase()];
    if (!media || count >= 200 || seen.has(file)) return;
    seen.add(file);
    try {
      const real = fs.realpathSync(file);
      if (
        !real.startsWith(cwd + path.sep) ||
        fs.lstatSync(file).isSymbolicLink()
      )
        return;
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      let content: Buffer;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return;
        content = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      count++;
      const name = path.relative(c.cwd, file);
      const id = store.artifact(c.ticketId, name, content, media, c.id);
      const key = "output:" + c.id + ":" + name;
      if (store.setting(key) === id) return;
      store.setting(key, id);
      store.message(
        c.id,
        "output:" + c.id + ":" + id,
        "tool",
        JSON.stringify({ label: name, artifactId: id }),
        "activity",
      );
      store.event(
        "artifact.created",
        c.id,
        { artifactId: id, name },
        c.ticketId,
      );
    } catch (error: any) {
      if (!["ENOENT", "ELOOP", "EACCES"].includes(error.code)) throw error;
    }
  };
  const walk = (dir: string, depth = 0) => {
    if (depth > 5 || count >= 200) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile()) capture(file);
    }
  };
  if (
    fs.existsSync(root) &&
    !fs.lstatSync(root).isSymbolicLink() &&
    fs.statSync(root).isDirectory()
  )
    walk(root);
  // Existing sessions may link deliverables outside outputs. Only import local
  // workspace links from their recent assistant messages, never arbitrary URLs.
  const messages = store.db
    .prepare(
      "SELECT content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 20",
    )
    .all(c.id) as any[];
  for (const message of messages) {
    for (const match of message.content.matchAll(
      /\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g,
    )) {
      let target = match[1].replace(/^<|>$/g, "").replace(/:\d+(?::\d+)?$/, "");
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#"))
        continue;
      capture(path.resolve(c.cwd, target));
    }
  }
}

export function recordNativeReads(store: Store, c: Conversation, item: any) {
  if (
    item.type !== "commandExecution" ||
    item.exitCode !== 0 ||
    !item.aggregatedOutput
  )
    return;
  for (const action of item.commandActions ?? []) {
    if (action.type !== "read" || !/\.md$/i.test(action.path)) continue;
    recordContext(
      store,
      c,
      path.basename(action.path),
      item.aggregatedOutput,
      "Provider-reported Markdown read; captured command output may be partial or include multiple files",
      path.resolve(item.cwd ?? c.cwd, action.path),
    );
  }
}
export function hydrateContext(store: Store, c: Conversation) {
  if (
    store.setting("context-hydrated:" + c.id + ":" + c.incarnation) ||
    !c.runnerId
  )
    return;
  const dir = path.join(store.home, "app", "runners", c.runnerId);
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(dir, "config.json"), "utf8"),
    );
    if (config.instructions)
      recordContext(
        store,
        c,
        "firstmate-session-instructions.md",
        config.instructions,
        "Captured native launch instructions from retained session configuration",
      );
    const journal = path.join(dir, "events.jsonl");
    if (fs.existsSync(journal) && fs.statSync(journal).size < 20 * 1024 * 1024)
      for (const line of fs.readFileSync(journal, "utf8").split("\n")) {
        try {
          const e = JSON.parse(line);
          if (
            e.type === "provider.event" &&
            e.payload.method === "item/completed"
          )
            recordNativeReads(store, c, e.payload.params.item);
        } catch {}
      }
    store.setting("context-hydrated:" + c.id + ":" + c.incarnation, true);
  } catch {}
}
