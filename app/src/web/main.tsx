import React, { useEffect, useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Ticket, Conversation } from "../contracts.ts";
import { useReading, engagePanel } from "./scroll.ts";
import "./style.css";
import {
  ArtifactReader,
  ArtifactLibrary,
  ContextBrowser,
  SkillsBrowser,
  openArtifact,
} from "./library.tsx";
import { usePanelWidth } from "./panels.ts";
let csrf = "";
async function api(url: string, options: RequestInit = {}) {
  let res = await fetch("/v1/" + url, options);
  if (res.status === 401 && url !== "session") {
    const session = await fetch("/v1/session").then((r) => r.json());
    csrf = session.csrf;
    res = await fetch("/v1/" + url, {
      ...options,
      headers: {
        ...options.headers,
        ...(options.method === "POST" ? { "X-CSRF-Token": csrf } : {}),
      },
    });
  }
  const data = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}
async function command(
  type: string,
  payload: any = {},
  targetId?: string,
  expectedVersion?: number,
) {
  return api("commands", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      type,
      targetId,
      expectedVersion,
      payload,
    }),
  });
}
const labels: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
  active: "Checking",
  awaiting_decision: "Your decision",
  queued: "Queued",
  backlog: "Backlog",
  completed: "Completed",
  cancelled: "Cancelled",
};
function App() {
  const sidebarWidth = usePanelWidth("navigation", 256, 220, 360);
  const contextWidth = usePanelWidth("context", 338, 280, 600);
  const [snapshot, setSnapshot] = useState<any>();
  const [view, setView] = useState(
    location.hash.startsWith("#message/") ||
      location.hash.startsWith("#ticket/")
      ? "work"
      : location.hash.slice(1) || "work",
  );
  const [selected, setSelected] = useState<string>();
  const [selectedConversation, setSelectedConversation] = useState<string>();
  const [context, setContext] = useState<"ticket" | "worker">("ticket");
  const [modal, setModal] = useState(false);
  const [settings, setSettings] = useState(false);
  const [artifactId, setArtifactId] = useState<string>();
  const [firstmateHistory, setFirstmateHistory] = useState<string>();
  const [theme, setTheme] = useState(localStorage.getItem("theme") ?? "system");
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    localStorage.setItem("theme", theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const show = (event: Event) => setArtifactId((event as CustomEvent).detail);
    const current = () => setFirstmateHistory(undefined);
    window.addEventListener("artifact.open", show);
    window.addEventListener("firstmate.current", current);
    return () => {
      window.removeEventListener("artifact.open", show);
      window.removeEventListener("firstmate.current", current);
    };
  }, []);
  const [error, setError] = useState("");
  const [humanFold, setHumanFold] = useState(false);
  const [mobile, setMobile] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await api("snapshot");
      setSnapshot(data);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    let events: EventSource;
    let timer: ReturnType<typeof setTimeout>;
    void (async () => {
      const session = await api("session");
      csrf = session.csrf;
      const s = await api("snapshot");
      setSnapshot(s);
      setHumanFold(s.layout?.humanFold ?? false);
      events = new EventSource("/v1/events?after=" + s.sequence);
      events.onmessage = () => {
        clearTimeout(timer);
        timer = setTimeout(refresh, 80);
      };
      events.onerror = () =>
        setError(
          "Connection interrupted. Your draft is saved; accepted work continues.",
        );
      events.onopen = () => setError("");
    })();
    return () => {
      events?.close();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const handler = () => {
      const route = location.hash.slice(1);
      if (route.startsWith("ticket/")) {
        setSelected(route.split("/")[1]);
        setContext("ticket");
        setView("work");
      } else if (route.startsWith("message/")) {
        const cid = route.split("/")[1];
        setView("work");
        void api("conversations/" + encodeURIComponent(cid))
          .then((d) => {
            if (d.conversation.ticketId) {
              setSelected(d.conversation.ticketId);
              setSelectedConversation(cid);
              setContext("worker");
            }
          })
          .catch((e) => setError(String(e)));
      } else setView(route || "work");
    };
    handler();
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  const act = async (
    type: string,
    payload: any = {},
    id?: string,
    version?: number,
  ) => {
    try {
      await command(type, payload, id, version);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  if (!snapshot) return <div className="loading">Opening your workspace…</div>;
  const tickets: Ticket[] = snapshot.tickets;
  const conversations: Conversation[] = snapshot.conversations;
  const currentFirstmate = conversations.find(
    (c) => c.role === "supervisor" && !c.retiredAt,
  );
  const supervisor =
    conversations.find((c) => c.id === firstmateHistory) ?? currentFirstmate;
  const ticket = tickets.find((t) => t.id === selected);
  const worker =
    conversations.find(
      (c) => c.id === selectedConversation && c.ticketId === selected,
    ) ?? conversations.find((c) => c.ticketId === selected);
  const navigate = (next: string) => {
    engagePanel("navigation");
    location.hash = next;
    setView(next);
    setMobile(false);
  };
  const groups = [
    {
      name: "Checking",
      tickets: tickets.filter(
        (t) => t.handling === "agent_managed" && t.status === "active",
      ),
    },
    {
      name: "Your decision",
      tickets: tickets.filter(
        (t) =>
          t.handling === "agent_managed" && t.status === "awaiting_decision",
      ),
    },
    {
      name: "Queued",
      tickets: tickets.filter(
        (t) =>
          t.handling === "agent_managed" &&
          ["queued", "backlog", "cancelled"].includes(t.status),
      ),
    },
    {
      name: "Human only",
      tickets: tickets.filter(
        (t) => t.handling === "human_only" && t.status !== "completed",
      ),
    },
  ];
  return (
    <div className="workspace">
      <button
        className="mobile-menu"
        onClick={() => setMobile(!mobile)}
        aria-label="Open navigation"
      >
        ☰
      </button>
      <aside
        {...sidebarWidth}
        className={"sidebar " + (mobile ? "open" : "")}
        onPointerDown={() => engagePanel("tickets")}
      >
        <div className="brand">
          <span className="mark">/</span> firstmate{" "}
          <span className="local">LOCAL</span>
        </div>
        <nav aria-label="Workspace">
          <button
            className={view === "work" ? "active" : ""}
            onClick={() => navigate("work")}
          >
            Work
          </button>
          <button
            className={view === "dashboards" ? "active" : ""}
            onClick={() => navigate("dashboards")}
          >
            Dashboards
          </button>
          <button
            className={view === "archive" ? "active" : ""}
            onClick={() => navigate("archive")}
          >
            Archive
          </button>
          {[
            ["skills", "Skills"],
            ["context", "Context"],
            ["artifacts", "Artifacts"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => navigate(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="section-title">
          <h1>Your work</h1>
          <button
            className="icon"
            onClick={() => setModal(true)}
            aria-label="New ticket"
          >
            ＋
          </button>
        </div>
        <div className="ticket-groups">
          {groups.map((g, i) => (
            <section className="ticket-group" key={g.name}>
              <button
                className="group-title"
                onClick={
                  i === 3
                    ? () => {
                        setHumanFold(!humanFold);
                        void act("layout.save", {
                          ...snapshot.layout,
                          humanFold: !humanFold,
                        });
                      }
                    : undefined
                }
                aria-expanded={i === 3 ? !humanFold : undefined}
              >
                <span>{g.name}</span>
                <span>
                  {g.tickets.length} {i === 3 ? (humanFold ? "⌄" : "⌃") : ""}
                </span>
              </button>
              {!(i === 3 && humanFold) &&
                (g.tickets.length ? (
                  g.tickets.map((t) => (
                    <button
                      key={t.id}
                      className={
                        "ticket-card " + (selected === t.id ? "selected" : "")
                      }
                      onClick={() => {
                        setSelected(t.id);
                        setContext("ticket");
                        navigate("work");
                      }}
                    >
                      <span className="ticket-meta">
                        {t.slug}
                        <span className={"priority " + t.priority}>
                          {labels[t.priority]}
                        </span>
                      </span>
                      <strong>{t.title}</strong>
                      <span className="subtle">
                        {t.handling === "human_only"
                          ? "Private to you"
                          : labels[t.status]}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="empty-group">
                    {i === 3
                      ? "Space for work you handle yourself."
                      : "Nothing here right now."}
                  </div>
                ))}
            </section>
          ))}
        </div>
        <footer>
          <button onClick={() => setSettings(true)}>⚙ Settings</button>
          <span className="status-dot">
            {snapshot.policy.paused ? "Dispatch paused" : "Runtime connected"}
          </span>
        </footer>
      </aside>
      <main
        onPointerDown={() =>
          engagePanel(view === "work" ? (supervisor?.id ?? "supervisor") : view)
        }
      >
        {error && (
          <div role="alert" className="error">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {view === "work" ? (
          <>
            {supervisor ? (
              <Chat
                key={supervisor.id}
                conversation={supervisor}
                act={act}
                history={conversations.filter((c) => c.role === "supervisor")}
                selectHistory={setFirstmateHistory}
              />
            ) : (
              <div className="welcome">
                <div className="eyebrow">YOUR LOCAL WORKSPACE</div>
                <h2>
                  One conversation.
                  <br />A clear view of the work.
                </h2>
                <p>
                  Your Firstmate coordinates managed tickets, follows up on
                  results, and brings decisions back to you.
                </p>
                <div className="notice">
                  {snapshot.policy.paused
                    ? "Dispatch is paused. Configure your provider, then enable dispatch when you want to run work."
                    : "Your provider will use its existing signed-in account."}
                </div>
                <ProviderForm role="supervisor" act={act} />
                <small>
                  Human only tickets stay out of agent conversations.
                </small>
              </div>
            )}
          </>
        ) : view === "dashboards" ? (
          <Dashboard version={snapshot.sequence} />
        ) : view === "skills" ? (
          <SkillsBrowser
            conversations={conversations}
            api={api}
            useSkill={(c, skill) => {
              localStorage.setItem(
                "skills:" + c.id,
                JSON.stringify([{ name: skill.name, path: skill.path }]),
              );
              if (!localStorage.getItem("draft:" + c.id))
                localStorage.setItem(
                  "draft:" + c.id,
                  "Use $" + skill.name + " to ",
                );
              if (c.ticketId) {
                setSelected(c.ticketId);
                setSelectedConversation(c.id);
                setContext("worker");
              } else setFirstmateHistory(c.id);
              navigate("work");
            }}
          />
        ) : view === "context" ? (
          <ContextBrowser api={api} />
        ) : view === "artifacts" ? (
          <ArtifactLibrary api={api} />
        ) : (
          <div className="page">
            <div className="eyebrow">RETAINED HISTORY</div>
            <h2>Archive</h2>
            <p className="subtle">
              Completed work, with its evidence and decisions intact.
            </p>
            {tickets.filter((t) => t.status === "completed").length === 0 ? (
              <div className="empty-panel">No completed tickets yet.</div>
            ) : (
              tickets
                .filter((t) => t.status === "completed")
                .map((t) => (
                  <div className="archive-row" key={t.id}>
                    <div>
                      <small>
                        {t.slug} · {labels[t.priority]} ·{" "}
                        {t.handling === "human_only" ? "Human only" : "Managed"}
                      </small>
                      <h3>{t.title}</h3>
                    </div>
                    <button
                      onClick={() => {
                        setSelected(t.id);
                        navigate("work");
                      }}
                    >
                      Details
                    </button>
                    <button
                      onClick={() => act("ticket.reopen", {}, t.id, t.version)}
                    >
                      Reopen
                    </button>
                  </div>
                ))
            )}
          </div>
        )}
      </main>
      {view === "work" && ticket && (
        <aside
          {...contextWidth}
          className="context"
          onPointerDownCapture={() => engagePanel("context")}
        >
          <header>
            <div className="tabs">
              <button
                className={context === "ticket" ? "active" : ""}
                onClick={() => setContext("ticket")}
              >
                Ticket
              </button>
              <button
                className={context === "worker" ? "active" : ""}
                disabled={ticket.handling === "human_only"}
                onClick={() => setContext("worker")}
              >
                Conversation
              </button>
            </div>
            <button
              className="icon"
              aria-label="Close context"
              onClick={() => setSelected(undefined)}
            >
              ×
            </button>
          </header>
          {context === "worker" && worker && (
            <select
              aria-label="Ticket conversation"
              value={worker.id}
              onChange={(e) => setSelectedConversation(e.target.value)}
            >
              {conversations
                .filter((c) => c.ticketId === selected)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.stage ?? "Implementation"} · {c.provider} · {c.state}
                  </option>
                ))}
            </select>
          )}
          {context === "worker" ? (
            worker ? (
              <Chat key={worker.id} conversation={worker} act={act} />
            ) : (
              <div className="context-content">
                <h3>Start a worker</h3>
                <p className="subtle">
                  A new worker gets its own Treehouse lease.
                </p>
                <ProviderForm role="worker" ticketId={ticket.id} act={act} />
              </div>
            )
          ) : (
            <TicketDetail
              ticket={ticket}
              version={snapshot.sequence}
              act={act}
              onWorker={() => setContext("worker")}
            />
          )}
        </aside>
      )}
      {modal && (
        <Modal title="New ticket" close={() => setModal(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const links = [];
              if (f.get("github"))
                links.push({ kind: "github_pr", url: String(f.get("github")) });
              if (f.get("linear"))
                links.push({
                  kind: "linear_project",
                  url: String(f.get("linear")),
                });
              try {
                const r = await command("ticket.create", {
                  title: f.get("title"),
                  brief: f.get("brief"),
                  priority: f.get("priority"),
                  handling: f.get("human") ? "human_only" : "agent_managed",
                  kind: f.get("kind"),
                  links,
                });
                await refresh();
                setSelected(r.ticketId);
                setModal(false);
                navigate("work");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <label>
              Title
              <input
                name="title"
                required
                maxLength={240}
                autoFocus
                placeholder="What needs to happen?"
              />
            </label>
            <label>
              Brief
              <textarea
                name="brief"
                rows={4}
                placeholder="Outcome, context, and acceptance criteria"
              />
            </label>
            <div className="form-row">
              <label>
                Priority
                <select name="priority" defaultValue="normal">
                  {["urgent", "high", "normal", "low"].map((p) => (
                    <option key={p} value={p}>
                      {labels[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Kind
                <select name="kind">
                  <option value="change">Change</option>
                  <option value="investigation">Investigation</option>
                </select>
              </label>
            </div>
            <label className="checkbox">
              <input type="checkbox" name="human" />
              Human only
            </label>
            <p className="help">
              Only you can see and handle this ticket. It won't enter agent
              context or dispatch.
            </p>
            <label>
              GitHub pull request
              <input
                type="url"
                name="github"
                placeholder="https://github.com/…/pull/123"
              />
            </label>
            <label>
              Linear project <span className="subtle">optional</span>
              <input
                type="url"
                name="linear"
                placeholder="https://linear.app/…/project/…"
              />
            </label>
            <button className="primary" type="submit">
              Create ticket
            </button>
          </form>
        </Modal>
      )}
      {artifactId && (
        <Modal title="Artifact" close={() => setArtifactId(undefined)}>
          <ArtifactReader key={artifactId} id={artifactId} api={api} />
        </Modal>
      )}
      {settings && (
        <Modal title="Workspace settings" close={() => setSettings(false)}>
          {snapshot.legacyExternalChanges?.requiresReconciliation && (
            <div className="notice" role="status">
              Legacy files changed outside the app. Review these changes before
              adopting them: {snapshot.legacyExternalChanges.changed.join(", ")}
              . Your app ticket state remains authoritative.
            </div>
          )}
          <label>
            Appearance
            <select
              aria-label="Appearance"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option value="system">System</option>
              <option value="light">Vaporwave · light</option>
              <option value="dark">Vaporwave · dark</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!snapshot.policy.paused}
              onChange={(e) =>
                act("runtime.pause", { paused: !e.target.checked })
              }
            />
            Enable dispatch
          </label>
          <p className="help">
            Uses your existing provider authentication. No account billing
            settings change.
          </p>
          <p className="help">
            Managed tickets notify Firstmate automatically when dispatch is
            enabled and control is returned. Take over interrupts the current
            turn and keeps automatic input paused even if you close the browser.
          </p>
          <h3>Cursor</h3>
          <div className="notice">{snapshot.capabilities.cursor.reason}</div>
          <p className="help">
            Development home. Live ownership has not transferred.
          </p>
        </Modal>
      )}
    </div>
  );
}
function ProviderForm({
  role,
  ticketId,
  act,
}: {
  role: string;
  ticketId?: string;
  act: Function;
}) {
  const [provider, setProvider] = useState("codex");
  return (
    <form
      className="provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void act("conversation.create", {
          provider,
          role,
          ticketId,
          model: f.get("model"),
        });
      }}
    >
      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="codex">Codex · native</option>
          <option value="claude" disabled={role === "supervisor"}>
            Claude ·{" "}
            {role === "supervisor"
              ? "worker controls under verification"
              : "native worker"}
          </option>
        </select>
      </label>
      <label>
        Model
        <input
          key={provider}
          name="model"
          defaultValue={
            provider === "codex" ? "gpt-5.6-sol" : "claude-sonnet-4-6"
          }
          required
        />
      </label>
      <button className="primary">
        Start {role === "supervisor" ? "Firstmate" : "worker"}
      </button>
    </form>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const focusable = () => [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea, select, a[href], [tabindex="0"]',
      ) ?? []),
    ];
    focusable()[0]?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const nodes = focusable();
        const i = nodes.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && i === nodes.length - 1) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="Close dialog" className="icon" onClick={close}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Chat({
  conversation: outer,
  act,
  history,
  selectHistory,
}: {
  conversation: Conversation;
  act: Function;
  history?: Conversation[];
  selectHistory?: (id: string) => void;
}) {
  const [data, setData] = useState<any>();
  const [draft, setDraft] = useState(
    localStorage.getItem("draft:" + outer.id) ?? "",
  );
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<any[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("attachments:" + outer.id) ?? "[]",
      );
    } catch {
      return [];
    }
  });
  const [pendingSend, setPendingSend] = useState<any>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("pending-send:" + outer.id) ?? "null",
      );
    } catch {
      return null;
    }
  });
  const [skills, setSkills] = useState<any[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("skills:" + outer.id) ?? "[]");
    } catch {
      return [];
    }
  });
  const [chatError, setChatError] = useState("");
  const [search, setSearch] = useState("");
  const [older, setOlder] = useState<any[]>([]);
  useEffect(() => {
    const followLink = () => {
      const [, cid, encodedMid] = location.hash.slice(1).split("/");
      const mid = encodedMid ? decodeURIComponent(encodedMid) : "";
      if (!location.hash.startsWith("#message/") || cid !== outer.id || !mid)
        return;
      engagePanel(outer.id);
      void api(
        "conversations/" + outer.id + "?message=" + encodeURIComponent(mid),
      )
        .then((d) => {
          setOlder(d.messages);
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              document.getElementById(mid)?.scrollIntoView({ block: "center" }),
            ),
          );
        })
        .catch((e) => setChatError(String(e)));
    };
    followLink();
    window.addEventListener("hashchange", followLink);
    return () => window.removeEventListener("hashchange", followLink);
  }, [outer.id]);
  const read = useReading(
    outer.id,
    data?.messages.map((m: any) => m.id + ":" + m.version).join(","),
  );
  useEffect(() => {
    let dead = false;
    let firstRead = true;
    const fetchData = async () => {
      const d = await api(
        "conversations/" +
          outer.id +
          (search ? "?search=" + encodeURIComponent(search) : ""),
      );
      if (firstRead && !search) {
        firstRead = false;
        try {
          const anchor = JSON.parse(
            sessionStorage.getItem("reading:" + outer.id) ?? "null",
          );
          if (anchor?.id && !d.messages.some((m: any) => m.id === anchor.id)) {
            const history = await api(
              "conversations/" +
                outer.id +
                "?message=" +
                encodeURIComponent(anchor.id),
            );
            const merged = new Map(
              [...history.messages, ...d.messages].map((m: any) => [m.id, m]),
            );
            d.messages = [...merged.values()].sort(
              (a: any, b: any) => a.sequence - b.sequence,
            );
          }
        } catch {
          /* A removed anchor falls back to the available history. */
        }
      }
      if (!dead)
        setData((previous: any) => {
          if (search || previous?.query !== search)
            return { ...d, query: search };
          const items = new Map(
            (previous?.messages ?? []).map((m: any) => [m.id, m]),
          );
          for (const message of d.messages) items.set(message.id, message);
          return {
            ...d,
            query: search,
            messages: [...items.values()].sort(
              (a: any, b: any) => a.sequence - b.sequence,
            ),
          };
        });
    };
    void fetchData();
    const timer = setInterval(() => void fetchData(), 800);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [outer.id, search]);
  const c: Conversation = data?.conversation ?? outer;
  const send = async () => {
    if ((!draft.trim() && !attachments.length && !pendingSend) || sending)
      return;
    setSending(true);
    try {
      const current = pendingSend ? null : await api("conversations/" + c.id);
      const envelope = pendingSend ?? {
        commandId: crypto.randomUUID(),
        type: "conversation.send",
        targetId: c.id,
        expectedVersion: current.conversation.version,
        payload: {
          text: draft.trim() ? draft : "Please review the attached files.",
          attachments: attachments.map((a) => a.id),
          skills,
        },
      };
      localStorage.setItem("pending-send:" + c.id, JSON.stringify(envelope));
      setPendingSend(envelope);
      await api("commands", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(envelope),
      });
      if (draft === envelope.payload.text || !draft.trim()) {
        setDraft("");
        localStorage.removeItem("draft:" + c.id);
      }
      const remaining = attachments.filter(
        (a) => !envelope.payload.attachments.includes(a.id),
      );
      setAttachments(remaining);
      localStorage.setItem("attachments:" + c.id, JSON.stringify(remaining));
      setSkills([]);
      localStorage.removeItem("skills:" + c.id);
      setPendingSend(null);
      localStorage.removeItem("pending-send:" + c.id);
      setChatError("");
    } catch (error: any) {
      if (error.status >= 400 && error.status < 500) {
        setPendingSend(null);
        localStorage.removeItem("pending-send:" + c.id);
      }
      setChatError(
        String(error) +
          (!error.status
            ? " Retry the saved send to reconcile delivery; its command ID stays the same."
            : ""),
      );
    } finally {
      setSending(false);
    }
  };
  const attach = async (file: File) => {
    if (file.size > 512 * 1024 || attachments.length >= 4) {
      setChatError("Attach up to four files, each at most 512 KiB.");
      return;
    }
    setSending(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const mediaType = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "application/json",
      ].includes(file.type)
        ? file.type
        : "text/plain";
      const current = await api("conversations/" + c.id);
      const result = await command(
        "conversation.attach",
        { name: file.name, mediaType, base64: btoa(binary) },
        c.id,
        current.conversation.version,
      );
      const next = [...attachments, result.attachment];
      setAttachments(next);
      localStorage.setItem("attachments:" + c.id, JSON.stringify(next));
    } catch (error) {
      setChatError(String(error));
    } finally {
      setSending(false);
    }
  };
  const messages = [...older, ...(data?.messages ?? [])].filter(
    (m: any, i: number, a: any[]) => a.findIndex((x) => x.id === m.id) === i,
  );
  return (
    <section className="chat">
      <header className="chat-header">
        <div>
          <h2>
            {c.role === "supervisor" ? "Firstmate" : "Worker conversation"}
          </h2>
          <small>
            {c.provider} · {c.model} <span className="state">{c.state}</span>
          </small>
        </div>
        <div className="chat-actions">
          {history && history.length > 1 && (
            <select
              aria-label="Firstmate chat history"
              value={c.id}
              onChange={(e) => selectHistory?.(e.target.value)}
            >
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.retiredAt
                    ? "Previous chat · " + h.id.slice(0, 8)
                    : "Current chat"}
                </option>
              ))}
            </select>
          )}
          {!c.retiredAt && <ConversationControls conversation={c} act={act} />}
          {!c.retiredAt && ["lost", "failed"].includes(c.state) && (
            <button
              onClick={() => act("conversation.resume", {}, c.id, c.version)}
            >
              Resume exact session
            </button>
          )}
          {!c.retiredAt && c.state === "idle" && c.runnerId && (
            <button
              onClick={() => act("conversation.park", {}, c.id, c.version)}
            >
              Park
            </button>
          )}
          <button
            onClick={() => act("conversation.interrupt", {}, c.id, c.version)}
            disabled={
              !!c.retiredAt ||
              !["running", "waiting_permission"].includes(c.state)
            }
          >
            Interrupt
          </button>
          <button
            disabled={!!c.retiredAt}
            title="Take over interrupts the current turn and pauses automatic input until you return control."
            onClick={() =>
              act(
                c.inputOwner === "automation"
                  ? "conversation.takeover"
                  : "conversation.return",
                {},
                c.id,
                c.version,
              )
            }
          >
            {c.inputOwner === "automation" ? "Take over" : "Return control"}
          </button>
        </div>
      </header>
      {chatError && (
        <div className="error" role="alert">
          {chatError}
        </div>
      )}
      <div className="search-row">
        <input
          aria-label="Search transcript"
          placeholder="Search conversation"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {c.inputOwner !== "automation" && <small>You're in control</small>}
      </div>
      <div
        ref={read.ref}
        className="transcript"
        tabIndex={0}
        {...read.handlers}
      >
        <div className="message-list">
          {messages.length >= 100 && (
            <button
              onClick={async () => {
                const next = await api(
                  "conversations/" + c.id + "?before=" + messages[0].sequence,
                );
                setOlder([...next.messages, ...older]);
              }}
            >
              Load earlier messages
            </button>
          )}
          {messages.length === 0 && (
            <div className="conversation-empty">
              <span className="small-mark">/</span>
              <h3>Ready when you are.</h3>
              <p>Describe the outcome you want, or ask about managed work.</p>
            </div>
          )}
          {messages
            .filter(
              (m: any) =>
                !search ||
                m.content.toLowerCase().includes(search.toLowerCase()),
            )
            .map((m: any) => (
              <article
                className={"message " + m.role}
                data-message-id={m.id}
                id={m.id}
                key={m.id}
              >
                <div className="message-author">
                  {m.role === "user"
                    ? "You"
                    : m.role === "assistant"
                      ? c.role === "supervisor"
                        ? "Firstmate"
                        : "Worker"
                      : "Activity"}
                  <a
                    href={"#message/" + c.id + "/" + encodeURIComponent(m.id)}
                    title="Link to message"
                  >
                    {new Date(m.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </a>
                </div>
                {m.attachments?.map((a: any) => (
                  <a
                    key={a.id}
                    className="external-link"
                    href={"#artifact/" + a.id}
                    onClick={(e) => {
                      e.preventDefault();
                      openArtifact(a.id);
                    }}
                  >
                    {a.name} ↗
                  </a>
                ))}
                {m.kind === "activity" ? (
                  <Activity content={m.content} />
                ) : (
                  <div className="message-body">{m.content}</div>
                )}
              </article>
            ))}
        </div>
      </div>
      {read.unread && (
        <button className="jump" onClick={read.jump}>
          New content · Jump to latest ↓
        </button>
      )}
      {data?.permissions
        .filter((p: any) => p.state === "pending")
        .map((p: any) => (
          <div className="permission" key={p.id}>
            <strong>Permission requested</strong>
            <pre>{JSON.stringify(p.data.item ?? p.data.params, null, 2)}</pre>
            <button
              onClick={() =>
                act(
                  "permission.reply",
                  { requestId: p.id, decision: "decline" },
                  c.id,
                  c.version,
                )
              }
            >
              Deny
            </button>
            <button
              onClick={() =>
                act(
                  "permission.reply",
                  { requestId: p.id, decision: "accept" },
                  c.id,
                  c.version,
                )
              }
            >
              Allow once
            </button>
          </div>
        ))}
      <div className="composer" onPointerDown={() => engagePanel(c.id)}>
        {attachments.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              const next = attachments.filter((item) => item.id !== a.id);
              setAttachments(next);
              localStorage.setItem("attachments:" + c.id, JSON.stringify(next));
            }}
          >
            {a.name} ×
          </button>
        ))}
        {pendingSend && !sending && (
          <small>
            A saved send needs reconciliation. Retrying keeps its original
            command ID.
          </small>
        )}
        <textarea
          aria-label="Message"
          disabled={!!c.retiredAt}
          placeholder={
            c.state === "running"
              ? "Queue a follow-up…"
              : c.retiredAt
                ? "This chat is retained history"
                : "Message your " +
                  (c.role === "supervisor" ? "Firstmate" : "worker") +
                  "…"
          }
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            localStorage.setItem("draft:" + c.id, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div>
          <label className="attach-control">
            Attach file
            <input
              type="file"
              aria-label="Attach file"
              disabled={sending}
              accept=".txt,.md,.json,.csv,.log,.js,.ts,.tsx,.png,.jpg,.jpeg,.webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void attach(file);
                e.target.value = "";
              }}
            />
          </label>
          {skills.map((skill) => (
            <button
              key={skill.path}
              className="skill-chip"
              onClick={() => {
                setSkills([]);
                localStorage.removeItem("skills:" + c.id);
              }}
              title="Remove selected skill"
            >
              ${skill.name} ×
            </button>
          ))}
          <button
            className="primary"
            disabled={
              !!c.retiredAt ||
              (!draft.trim() && !attachments.length && !pendingSend) ||
              sending
            }
            onClick={() => void send()}
          >
            {sending
              ? "Saving…"
              : pendingSend
                ? "Retry saved send"
                : c.state === "running"
                  ? "Queue"
                  : "Send"}{" "}
            ↑
          </button>
        </div>
      </div>
    </section>
  );
}
function Activity({ content }: { content: string }) {
  try {
    const data = JSON.parse(content);
    return (
      <details>
        <summary>{data.label}</summary>
        <a
          href={"#artifact/" + data.artifactId}
          onClick={(e) => {
            e.preventDefault();
            openArtifact(data.artifactId);
          }}
        >
          Open activity artifact ↗
        </a>
      </details>
    );
  } catch {
    return <span>{content}</span>;
  }
}
function TicketDetail({
  ticket: t,
  version,
  act,
  onWorker,
}: {
  ticket: Ticket;
  version: number;
  act: Function;
  onWorker: () => void;
}) {
  const [detail, setDetail] = useState<any>();
  useEffect(() => {
    void api("tickets/" + t.id).then(setDetail);
  }, [t.id, version]);
  return (
    <div className="context-content">
      <div className="eyebrow">
        {t.slug} · {labels[t.status]}
      </div>
      <h2>{t.title}</h2>
      <label>
        Priority
        <select
          value={t.priority}
          onChange={(e) =>
            act("ticket.update", { priority: e.target.value }, t.id, t.version)
          }
        >
          {["urgent", "high", "normal", "low"].map((p) => (
            <option value={p} key={p}>
              {labels[p]}
            </option>
          ))}
        </select>
      </label>
      <p className="brief">{t.brief || "No brief yet."}</p>
      {t.handling === "human_only" ? (
        <div className="notice">
          Human only. This ticket is excluded from agent context and actions.
        </div>
      ) : (
        <>
          <h3>Delivery</h3>
          <p className="subtle">
            {t.completionContract === "merge"
              ? "Completes after a verified merge."
              : "Completes after verified deliverable evidence."}
          </p>
          <button onClick={onWorker}>Open worker conversation ↗</button>
          {!["completed", "cancelled"].includes(t.status) &&
            t.kind === "change" && (
              <div className="detail-actions">
                <button
                  onClick={() => act("ticket.validate", {}, t.id, t.version)}
                >
                  Run independent checks
                </button>
                <button
                  disabled={!t.revision}
                  onClick={() => act("ticket.review", {}, t.id, t.version)}
                >
                  Run independent review
                </button>
                {t.revision &&
                  detail?.revisionFacts?.repository?.match(
                    /joinhandshake[/:]joinera(?:\.git)?$/,
                  ) && (
                    <details>
                      <summary>Create draft pull request</summary>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          void act(
                            "ticket.draftPr",
                            {
                              title: data.get("title"),
                              body: data.get("body"),
                            },
                            t.id,
                            t.version,
                          );
                        }}
                      >
                        <label>
                          Pull request title
                          <input
                            name="title"
                            required
                            maxLength={240}
                            defaultValue={t.title}
                          />
                        </label>
                        <label>
                          Description
                          <textarea
                            name="body"
                            required
                            minLength={20}
                            rows={6}
                            placeholder="Describe the problem, resulting behavior, and validation."
                          />
                        </label>
                        <p className="subtle">
                          Runs the Joinera gate, pushes the validated branch,
                          and creates a draft pull request.
                        </p>
                        <button type="submit">Run gate and create draft</button>
                      </form>
                    </details>
                  )}
                {t.links.some((l) => l.kind === "github_pr") && (
                  <button
                    disabled={!t.revision}
                    onClick={() => act("ticket.refreshPr", {}, t.id, t.version)}
                  >
                    Refresh PR evidence
                  </button>
                )}
              </div>
            )}
        </>
      )}
      <h3>Links</h3>
      {t.links.length ? (
        t.links.map((l) => (
          <a
            className="external-link"
            key={l.url}
            href={l.url}
            target="_blank"
            rel="noreferrer"
          >
            {l.kind === "github_pr" ? "GitHub pull request" : "Linear project"}{" "}
            ↗
          </a>
        ))
      ) : (
        <p className="subtle">No links attached.</p>
      )}
      <details>
        <summary>Add link</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(
              "ticket.update",
              {
                links: [...t.links, { kind: f.get("kind"), url: f.get("url") }],
              },
              t.id,
              t.version,
            );
          }}
        >
          <select name="kind">
            <option value="github_pr">GitHub pull request</option>
            <option value="linear_project">Linear project</option>
          </select>
          <input type="url" name="url" aria-label="Link URL" required />
          <button>Add</button>
        </form>
      </details>
      {detail?.legacy && (
        <div className="notice">
          Imported legacy record · Externally managed.{" "}
          {detail.legacy.completion}
        </div>
      )}
      {detail?.findings
        ?.filter((f: any) => f.status !== "resolved")
        .map((f: any) => (
          <div className="notice" key={f.id}>
            <strong>
              {f.severity}: {f.title}
            </strong>
            <p>{f.description}</p>
            <small>{f.location}</small>
          </div>
        ))}
      {t.handling === "agent_managed" &&
        !["completed", "cancelled"].includes(t.status) &&
        detail?.findings?.some((f: any) => f.status !== "resolved") && (
          <button onClick={() => act("ticket.repair", {}, t.id, t.version)}>
            Start bounded repair
          </button>
        )}
      {t.kind === "change" &&
        t.handling === "agent_managed" &&
        detail?.ciConfiguration?.configured === false && (
          <p className="notice">
            Required CI checks are not configured. CI evidence stays unverified
            until you configure the expected check names.
          </p>
        )}
      <h3>Stages and evidence</h3>
      {detail?.attempts.length ? (
        detail.attempts.map((a: any) => (
          <div className="stage" key={a.id}>
            <strong>
              {a.role} · Attempt {a.ordinal}
            </strong>
            <span>{a.state}</span>
            {["failed", "interrupted"].includes(a.state) && (
              <button
                onClick={() =>
                  act("stage.retry", { stage: a.role }, t.id, t.version)
                }
              >
                Retry
              </button>
            )}
          </div>
        ))
      ) : (
        <p className="subtle">No attempts yet.</p>
      )}
      {detail?.evidence.map((e: any) => (
        <div className="stage" key={e.id}>
          {e.requirement}
          <span>{e.revision === t.revision ? e.verdict : "stale"}</span>
        </div>
      ))}
      {detail?.closures.map((c: any, i: number) => (
        <div className="notice" key={i}>
          Completed {c.source === "manual" ? "manually" : "from evidence"} on{" "}
          {new Date(c.completedAt).toLocaleDateString()}. {c.note}
        </div>
      ))}
      <div className="detail-actions">
        <button
          onClick={() =>
            act(
              t.status === "completed" ? "ticket.reopen" : "ticket.complete",
              {},
              t.id,
              t.version,
            )
          }
        >
          {t.status === "completed" ? "Reopen ticket" : "Mark completed"}
        </button>
        <small>
          Manual completion preserves the current evidence and safely stops
          pending work.
        </small>
      </div>
    </div>
  );
}
function Dashboard({ version }: { version: number }) {
  const [data, setData] = useState<any>();
  const [period, setPeriod] = useState("30");
  useEffect(() => {
    void api("usage").then(setData);
  }, [version]);
  const rows = new Map<string, any>();
  for (const u of data?.observations ?? []) {
    if (Date.now() - Date.parse(u.observed_at) > Number(period) * 86400000)
      continue;
    const key = u.data.provider + ":" + u.model + ":" + u.data.role;
    const r = rows.get(key) ?? {
      model: u.model,
      provider: u.data.provider,
      role: u.data.role,
      input: 0,
      output: 0,
      unknown: false,
      runs: new Set(),
    };
    r.input += u.input ?? 0;
    r.output += u.output ?? 0;
    r.unknown ||= u.input === null || u.output === null;
    r.runs.add(u.conversation_id);
    rows.set(key, r);
  }
  const all = [...rows.values()];
  const total = all.reduce((n, r) => n + r.input + r.output, 0);
  return (
    <div className="page">
      <div className="eyebrow">OBSERVED APP ACTIVITY</div>
      <div className="page-title">
        <h2>Usage by model</h2>
        <select
          aria-label="Date range"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        >
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="365">Last year</option>
        </select>
      </div>
      <p className="subtle">
        Firstmate and worker activity, including failed and retried work.
      </p>
      <div className="metrics">
        <div>
          <small>Observed tokens</small>
          <strong>{total.toLocaleString()}</strong>
        </div>
        <div>
          <small>Models</small>
          <strong>{new Set(all.map((r) => r.model)).size}</strong>
        </div>
        <div>
          <small>Usage scope</small>
          <strong>Firstmate</strong>
        </div>
      </div>
      {all.length ? (
        <table>
          <thead>
            <tr>
              <th>Model / role</th>
              <th>Input</th>
              <th>Output</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {all.map((r) => (
              <tr key={r.provider + r.model + r.role}>
                <td>
                  <strong>{r.model}</strong>
                  <small>
                    {r.provider} ·{" "}
                    {r.role === "supervisor" ? "Firstmate" : r.role}
                  </small>
                </td>
                <td>{r.input.toLocaleString()}</td>
                <td>{r.output.toLocaleString()}</td>
                <td>{r.unknown ? "Partial" : "Measured"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-panel">
          <h3>No usage observations yet</h3>
          <p>
            Real provider usage appears here after a run reports it. Missing
            telemetry is not zero account usage.
          </p>
        </div>
      )}
      <div className="notice">
        This dashboard covers this app's observed activity. Account allowance,
        subscription spend, and unrelated provider activity are separate.
      </div>
      <AccountDashboard api={api} />
      <h3>Cursor budget</h3>
      <p>
        5,000 input + output tokens per calendar month · America/Los_Angeles ·
        No rollover
      </p>
      <span className="badge">
        Unavailable until whole-run hard-cap enforcement is verified
      </span>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

function ConversationControls({
  conversation: c,
  act,
}: {
  conversation: Conversation;
  act: Function;
}) {
  const [mode, setMode] = useState<"model" | "restart" | null>(null);
  const [models, setModels] = useState<any[]>([]);
  const [selected, setSelected] = useState(c.model);
  const [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "model") return;
    let live = true;
    setError("");
    void api("catalog?topic=models&conversationId=" + c.id)
      .then((d) => live && setModels(d.data))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [mode, c.id]);
  return (
    <>
      <button
        disabled={c.state !== "idle" || c.provider !== "codex"}
        onClick={() => {
          setSelected(c.model);
          setMode("model");
        }}
      >
        Model
      </button>
      {c.role === "supervisor" && (
        <button
          disabled={c.state !== "idle"}
          onClick={() => setMode("restart")}
        >
          New chat
        </button>
      )}
      {mode && (
        <Modal
          title={
            mode === "model" ? "Choose model" : "Start a new Firstmate chat"
          }
          close={() => setMode(null)}
        >
          {mode === "model" ? (
            <>
              <p className="subtle">
                Applies to the next turn. Your current chat and ticket history
                stay intact.
              </p>
              {error && <p role="alert">{error}</p>}
              <label>
                Model
                <select
                  aria-label="Firstmate model"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {!models.length && <option value={c.model}>{c.model}</option>}
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={!models.length || c.state !== "idle"}
                onClick={async () => {
                  await act(
                    "conversation.model",
                    { model: selected },
                    c.id,
                    c.version,
                  );
                  setMode(null);
                }}
              >
                Use model
              </button>
            </>
          ) : (
            <>
              <p>
                This creates a fresh native conversation using {c.model}. Your
                previous chat, tickets, artifacts, and recorded context remain
                available.
              </p>
              <p>
                Skills stay available through the same provider configuration.
                Previously loaded skill text isn't copied into the new
                conversation. Automatic control starts paused for the new chat.
              </p>
              <button
                className="primary"
                onClick={async () => {
                  await act("conversation.restart", {}, c.id, c.version);
                  setMode(null);
                  window.dispatchEvent(new Event("firstmate.current"));
                }}
              >
                Create new chat
              </button>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
function AccountDashboard({ api }: { api: (url: string) => Promise<any> }) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    setError("");
    void api("catalog?topic=account")
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  const buckets =
    data?.limits?.rateLimitsByLimitId ??
    (data?.limits?.rateLimits ? { codex: data.limits.rateLimits } : {});
  const recent = (data?.usage?.dailyUsageBuckets ?? []).slice(-14);
  const max = Math.max(1, ...recent.map((b: any) => b.tokens));
  return (
    <section className="account-dashboard">
      <div className="page-title">
        <h2>Account & subscription</h2>
        <button onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh account"}
        </button>
      </div>
      <p className="subtle">
        Account allowance, subscription spend, and unrelated provider activity.
        Provider account data is separate from this app's measured runs.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="account-cards">
        <div className="account-card">
          <h3>Account allowance</h3>
          {Object.entries(buckets).map(([key, value]: [string, any]) => (
            <div key={key}>
              <strong>{value.limitName ?? key}</strong>
              {value.individualLimit?.remainingPercent != null && (
                <>
                  <div className="account-number">
                    {value.individualLimit.remainingPercent}%{" "}
                    <small>remaining</small>
                  </div>
                  <progress
                    max={100}
                    value={value.individualLimit.remainingPercent}
                  />
                  <p className="subtle">
                    Resets{" "}
                    {new Date(
                      value.individualLimit.resetsAt * 1000,
                    ).toLocaleString()}
                  </p>
                </>
              )}
              {[value.primary, value.secondary]
                .filter(Boolean)
                .map((w: any, i: number) => (
                  <p key={i}>
                    {Math.max(0, 100 - w.usedPercent)}% remaining ·{" "}
                    {w.windowDurationMins / 60} hour window · resets{" "}
                    {new Date(w.resetsAt * 1000).toLocaleString()}
                  </p>
                ))}
              {!value.individualLimit && !value.primary && !value.secondary && (
                <p>Window details unavailable.</p>
              )}
            </div>
          ))}
          {!Object.keys(buckets).length && (
            <p>{loading ? "Reading allowance…" : "Unavailable"}</p>
          )}
          <small>Codex · signed-in account</small>
        </div>
        <div className="account-card">
          <h3>Subscription spend</h3>
          <div className="account-number">Unavailable</div>
          <p className="subtle">
            {data?.subscriptionSpendReason ??
              "Subscription invoices aren't exposed by the provider metadata connection."}
          </p>
          <p className="subtle">No estimate is presented as a billed charge.</p>
        </div>
        <div className="account-card">
          <h3>Account-wide activity</h3>
          <div className="account-number">
            {data?.usage?.summary?.lifetimeTokens?.toLocaleString() ??
              "Unavailable"}
          </div>
          <p className="subtle">
            Account-wide lifetime tokens, including other Codex clients. The
            provider doesn't separately identify activity unrelated to this app.
          </p>
          <small>Claude and Cursor account activity unavailable</small>
        </div>
      </div>
      {!!recent.length && (
        <>
          <h3>Recent account activity</h3>
          <div className="usage-bars" aria-label="Daily account tokens">
            {recent.map((b: any) => (
              <div
                key={b.startDate}
                title={
                  b.startDate + ": " + b.tokens.toLocaleString() + " tokens"
                }
              >
                <span
                  style={{ height: Math.max(3, (b.tokens / max) * 100) + "%" }}
                />
                <small>{b.startDate.slice(5)}</small>
              </div>
            ))}
          </div>
        </>
      )}
      {data && (
        <p className="subtle">
          Provider observation: {new Date(data.observedAt).toLocaleString()}.
          Metadata refreshes are cached for one minute.
        </p>
      )}
    </section>
  );
}
