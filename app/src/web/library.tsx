import React, { useEffect, useState } from "react";
import { Markdown } from "./markdown.tsx";
export { Markdown } from "./markdown.tsx";
import type { Conversation } from "../contracts.ts";
type Api = (url: string) => Promise<any>;
export const openArtifact = (id: string) =>
  window.dispatchEvent(new CustomEvent("artifact.open", { detail: id }));
export function ArtifactReader({ id, api }: { id: string; api: Api }) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api("artifacts/" + id + "?preview=1")
      .then((d) => live && setData(d))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [id]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>Opening artifact…</p>;
  const media = data.media_type;
  const src = "data:" + media + ";base64," + data.base64;
  return (
    <div className="artifact-reader">
      <div className="artifact-meta">
        <strong>{data.name}</strong>
        <a href={"/v1/artifacts/" + id} download={data.name}>
          Download
        </a>
      </div>
      {media === "text/html" ? (
        <iframe
          title={data.name}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={"/v1/artifacts/" + id + "?frame=1"}
        />
      ) : media.startsWith("image/") ? (
        <img
          alt={data.name}
          src={
            media === "image/svg+xml"
              ? "data:image/svg+xml," + encodeURIComponent(data.text)
              : src
          }
        />
      ) : media === "application/pdf" ? (
        <iframe title={data.name} src={src} />
      ) : media === "text/markdown" ? (
        <Markdown text={data.text} />
      ) : (
        <pre>{data.text}</pre>
      )}
    </div>
  );
}
export function SkillsBrowser({
  conversations,
  api,
  useSkill,
}: {
  conversations: Conversation[];
  api: Api;
  useSkill: (c: Conversation, s: any) => void;
}) {
  const [cid, setCid] = useState(
    conversations.find((c) => c.role === "supervisor" && !c.retiredAt)?.id ??
      conversations[0]?.id ??
      "",
  );
  const [data, setData] = useState<any>();
  const [selected, setSelected] = useState<any>();
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(null);
    setSelected(null);
    setError("");
    if (cid)
      void api("catalog?topic=skills&conversationId=" + cid)
        .then((d) => live && setData(d))
        .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [cid]);
  const skills = (data?.data ?? [])
    .flatMap((e: any) => e.skills)
    .filter((s: any) =>
      (s.name + " " + s.description)
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  return (
    <div className="page">
      <div className="eyebrow">YOUR TOOLKIT</div>
      <h2>Skills</h2>
      <p className="subtle">
        Available skills from the native provider. Browsing a skill doesn't add
        it to a conversation. Skills that depend on legacy terminal control may
        need adaptation.
      </p>
      <div className="library-toolbar">
        <select
          aria-label="Skills session"
          value={cid}
          onChange={(e) => setCid(e.target.value)}
        >
          {conversations
            .filter((c) => c.provider === "codex" && !c.retiredAt)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.role === "supervisor" ? "Firstmate" : "Worker"} ·{" "}
                {c.id.slice(0, 8)}
              </option>
            ))}
        </select>
        <input
          aria-label="Search skills"
          placeholder="Search skills"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {!cid && <p>Start a Firstmate conversation to browse its skills.</p>}
      {cid && !data && !error && <p>Reading native skill catalog…</p>}
      <div className="library-grid">
        <div className="library-list">
          {skills.map((s: any) => (
            <button
              key={s.path}
              onClick={() => {
                void api(
                  "skill?conversationId=" +
                    cid +
                    "&path=" +
                    encodeURIComponent(s.path),
                )
                  .then(setSelected)
                  .catch((e) => setError(String(e)));
              }}
            >
              <strong>{s.name}</strong>
              <small>{s.description}</small>
              <span className="tag">
                {s.enabled ? "Available" : "Disabled"} · {s.scope}
              </span>
            </button>
          ))}
        </div>
        <div className="library-document">
          {selected ? (
            <>
              <div className="page-title">
                <h3>{selected.name}</h3>
                <button
                  disabled={!selected.enabled}
                  onClick={() =>
                    useSkill(
                      conversations.find((c) => c.id === cid)!,
                      selected,
                    )
                  }
                >
                  Use in chat
                </button>
              </div>
              <p className="subtle path">{selected.path}</p>
              <Markdown text={selected.content} />
            </>
          ) : (
            <p className="subtle">Choose a skill to read its instructions.</p>
          )}
        </div>
      </div>
    </div>
  );
}
export function ContextBrowser({ api }: { api: Api }) {
  const [data, setData] = useState<any>();
  const [cid, setCid] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api("context")
      .then((d) => {
        setData(d);
        setCid(
          d.sessions.find(
            (s: any) =>
              s.conversation.role === "supervisor" && !s.conversation.retiredAt,
          )?.conversation.id ??
            d.sessions[0]?.conversation.id ??
            "",
        );
      })
      .catch((e) => setError(String(e)));
  }, []);
  const session = data?.sessions.find((s: any) => s.conversation.id === cid);
  return (
    <div className="page">
      <div className="eyebrow">SESSION MEMORY</div>
      <h2>Context</h2>
      <p className="subtle">
        {data?.coverage ??
          "Inspect the Markdown captured for each native session."}
      </p>
      {error && <p role="alert">{error}</p>}
      <select
        aria-label="Context session"
        value={cid}
        onChange={(e) => setCid(e.target.value)}
      >
        {data?.sessions.map((s: any) => (
          <option value={s.conversation.id} key={s.conversation.id}>
            {s.conversation.role === "supervisor" ? "Firstmate" : "Worker"} ·{" "}
            {s.conversation.id.slice(0, 8)}
            {s.conversation.retiredAt ? " · previous chat" : ""}
          </option>
        ))}
      </select>
      <p className="subtle path">
        Native session: {session?.conversation.providerId ?? "Not bound"}
      </p>
      {session?.documents.length ? (
        <div className="library-list">
          {session.documents.map((d: any, i: number) => (
            <button
              key={d.artifactId + ":" + i}
              onClick={() => openArtifact(d.artifactId)}
            >
              <strong>{d.name}</strong>
              <small>
                {d.source} · session incarnation {d.incarnation}
              </small>
              <span className="path">{d.path}</span>
              <small>{new Date(d.recordedAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-panel">
          No captured Markdown for this session. Older sessions predate context
          recording; the app won't invent their history.
        </div>
      )}
    </div>
  );
}
export function ArtifactLibrary({
  api,
  conversationId,
}: {
  api: Api;
  conversationId?: string;
}) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  useEffect(() => {
    void api(
      "library" + (conversationId ? "?conversationId=" + conversationId : ""),
    )
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [conversationId]);
  return (
    <div className="page">
      <div className="eyebrow">DELIVERABLES & EVIDENCE</div>
      <h2>Artifacts</h2>
      <p className="subtle">
        Open generated reports and files here. Deliverables in a session’s
        outputs folder and linked local workspace files are collected after each
        turn.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="library-list">
        {data?.artifacts.map((a: any) => (
          <button key={a.id} onClick={() => openArtifact(a.id)}>
            <strong>{a.name}</strong>
            <small>
              {a.media_type} · {Math.ceil(a.size / 1024)} KB
            </small>
          </button>
        ))}
      </div>
      {data?.artifacts.length === 0 && <p>No artifacts collected yet.</p>}
    </div>
  );
}
