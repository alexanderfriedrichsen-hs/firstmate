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
import { ProviderSettings } from "./providers.tsx";
import { UserQuestions } from "./questions.tsx";
import { Markdown } from "./markdown.tsx";
import {
  HeartbeatSettings,
  useHeartbeatHealth,
  HeartbeatStatus,
  type Heartbeat,
} from "./heartbeat.tsx";
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
  awaiting_decision: "Needs your review",
  queued: "Queued",
  backlog: "Backlog",
  completed: "Completed",
  cancelled: "Cancelled",
};
function App() {
  const sidebarWidth = usePanelWidth("navigation", 256, 220, 360);
  const contextWidth = usePanelWidth("context", 338, 280, 600);
  const [snapshot, setSnapshot] = useState<any>();
  const heartbeatHealth = useHeartbeatHealth(snapshot?.heartbeat);
  useEffect(() => {
    if (!snapshot) return;
    let active = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void api("heartbeat", { signal: AbortSignal.timeout(10000) })
        .then((heartbeat) => {
          if (active)
            setSnapshot((current: any) =>
              current ? { ...current, heartbeat } : current,
            );
        })
        .catch(() => {
          /* Keep the last server timestamp so missing heartbeats become stale. */
        })
        .finally(() => {
          pending = false;
        });
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [!!snapshot]);
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
      name: "Needs your review",
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
      <aside {...sidebarWidth} className={"sidebar " + (mobile ? "open" : "")}>
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
        <button
          className="review-notification"
          aria-label={`${groups[1].tickets.length} tickets need your review`}
          onClick={() => {
            const ticket = groups[1].tickets[0];
            if (ticket) {
              setSelected(ticket.id);
              setContext("ticket");
              navigate("work");
            }
          }}
          disabled={!groups[1].tickets.length}
        >
          <span>Needs your review</span>
          <span className="notification-count" role="status">
            {groups[1].tickets.length}
          </span>
        </button>
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
          {snapshot.heartbeat &&
            (["attention", "stale"].includes(heartbeatHealth ?? "") ||
              snapshot.heartbeat.issues?.length > 0) && (
              <button
                onClick={() => navigate("dashboards")}
                className="heartbeat-attention"
              >
                Heartbeat needs attention
              </button>
            )}
          <button onClick={() => setSettings(true)}>⚙ Settings</button>
          <span className="status-dot">
            {snapshot.policy.paused ? "Dispatch paused" : "Runtime connected"}
          </span>
        </footer>
      </aside>
      <main>
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
          <Dashboard
            version={snapshot.sequence}
            cursor={snapshot.policy.cursor}
            heartbeat={snapshot.heartbeat}
          />
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
        <aside {...contextWidth} className="context">
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
                  ...(f.get("projectId")
                    ? { projectId: String(f.get("projectId")) }
                    : {}),
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
            <label>
              Project
              <select name="projectId" aria-label="Project" defaultValue="">
                <option value="">Let Firstmate choose from the brief</option>
                {(snapshot.projects ?? []).map((project: any) => (
                  <option key={project.id} value={project.id}>
                    {project.id} · {project.remote}
                  </option>
                ))}
              </select>
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
            enabled and automatic work is enabled in its chat. Pause automatic
            work interrupts that conversation and switches it to manual
            messages. Other workers continue. Dispatch is the workspace-wide
            switch.
          </p>
          <HeartbeatSettings
            heartbeat={snapshot.heartbeat}
            save={async (value) => {
              await command("heartbeat.configure", value);
              await refresh();
            }}
          />
          <ProviderSettings
            api={api}
            cursor={snapshot.policy.cursor}
            enableCursor={() => act("provider.cursor.subscription")}
            post={(url) =>
              api(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrf,
                },
                body: "{}",
              })
            }
          />
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
  const [models, setModels] = useState<any[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setModels([]);
    setModel("");
    setEffort("");
    setError("");
    void api("catalog?topic=models&provider=" + provider)
      .then((result) => {
        if (!live) return;
        setModels(result.data);
        setModel(result.data[0]?.model ?? "");
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [provider]);
  return (
    <form
      className="provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        void act("conversation.create", {
          provider,
          role,
          ticketId,
          model,
          effort,
        });
      }}
    >
      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
          <option value="cursor">Cursor</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <label>
        Model
        <select
          value={model}
          disabled={!models.length}
          onChange={(e) => {
            setModel(e.target.value);
            setEffort("");
          }}
        >
          {!models.length && <option value="">No models loaded</option>}
          {models.map((m) => (
            <option key={m.model} value={m.model}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Thinking effort
        <select value={effort} onChange={(e) => setEffort(e.target.value)}>
          <option value="">Model default</option>
          {(
            models.find((m) => m.model === model)?.supportedReasoningEfforts ??
            []
          ).map((e: any) => (
            <option key={e.reasoningEffort} value={e.reasoningEffort}>
              {e.reasoningEffort}
            </option>
          ))}
        </select>
      </label>
      <p className="help">
        Sign in through Settings &gt; Providers before starting work.
      </p>
      <button className="primary" disabled={!model}>
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
  const [slashSkills, setSlashSkills] = useState<any[]>([]);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashError, setSlashError] = useState("");
  const [slashLoading, setSlashLoading] = useState(false);
  const [slashSelectionError, setSlashSelectionError] = useState("");
  const slashQuery = /^\/([^\s]*)$/.exec(draft)?.[1];
  const slashOpen =
    slashQuery !== undefined && !slashDismissed && !outer.retiredAt;
  useEffect(() => {
    if (!slashOpen || outer.provider !== "codex") return;
    let live = true;
    setSlashError("");
    setSlashLoading(true);
    void api("catalog?topic=skills&conversationId=" + outer.id)
      .then((result) => {
        if (live)
          setSlashSkills(
            result.data
              .flatMap((entry: any) => entry.skills ?? [])
              .filter((skill: any) => skill.enabled),
          );
      })
      .catch((e) => live && setSlashError(String(e)))
      .finally(() => live && setSlashLoading(false));
    return () => {
      live = false;
    };
  }, [slashOpen, outer.id, outer.provider]);
  const slashItems = [
    ...["skills", "artifacts", "context"].map((name) => ({
      id: "command:" + name,
      name,
      description: "Open " + name + " browser",
      kind: "App command",
    })),
    ...(data?.nativeCommands ?? []).map((command: any) => ({
      ...command,
      id: "native:" + command.name,
      kind: "Provider command",
    })),
    ...(outer.provider === "codex" ? slashSkills : []).map((skill) => ({
      ...skill,
      id: "skill:" + skill.path,
      kind: "Skill",
    })),
  ].filter((item) =>
    (item.name + " " + item.description)
      .toLowerCase()
      .includes((slashQuery ?? "").toLowerCase()),
  );
  useEffect(() => {
    if (slashOpen)
      document
        .getElementById("slash-option-" + outer.id + "-" + slashIndex)
        ?.scrollIntoView({ block: "nearest" });
  }, [slashIndex, slashOpen, outer.id]);
  const chooseSlash = (item: any) => {
    if (!item) return;
    if (item.kind === "Skill") {
      if (
        skills.length >= 4 &&
        !skills.some((skill) => skill.path === item.path)
      ) {
        setSlashSelectionError(
          "You can attach up to four skills. Remove a selected skill before adding another.",
        );
        return;
      }
      setSlashSelectionError("");
      const next = [
        ...skills.filter((skill) => skill.path !== item.path),
        { name: item.name, path: item.path },
      ];
      setSkills(next);
      localStorage.setItem("skills:" + outer.id, JSON.stringify(next));
      const text = "Use $" + item.name + " to ";
      setDraft(text);
      localStorage.setItem("draft:" + outer.id, text);
    } else if (item.kind === "Provider command") {
      const text = "/" + item.name + " ";
      setDraft(text);
      localStorage.setItem("draft:" + outer.id, text);
    } else {
      setDraft("");
      localStorage.removeItem("draft:" + outer.id);
      location.hash = item.name;
    }
    setSlashDismissed(true);
  };
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
            {c.provider} · {c.model}
            {c.effort ? " · " + c.effort + " effort" : ""}{" "}
            <span className="state">{c.state}</span>
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
            title="Pause interrupts this conversation and blocks automatic input. Other workers continue. You can still send messages yourself."
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
            {c.inputOwner === "automation"
              ? "Pause automatic work"
              : "Enable automatic work"}
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
        <small className="control-explanation">
          {c.retiredAt
            ? "Previous chat · read only"
            : c.inputOwner === "automation"
              ? "Automatic: picks up Managed work when dispatch is enabled. You can still chat."
              : "Manual: waits for your messages. Automatic work in this chat is paused; other workers can continue."}
        </small>
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
                className={
                  "message " +
                  (m.kind === "scheduled_heartbeat"
                    ? "scheduled-heartbeat"
                    : m.role)
                }
                data-message-id={m.id}
                id={m.id}
                key={m.id}
              >
                <div className="message-author">
                  {m.kind === "scheduled_heartbeat"
                    ? "System"
                    : m.role === "user"
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
                {m.kind === "scheduled_heartbeat" ? (
                  <details className="heartbeat-message">
                    <summary>Scheduled fleet review</summary>
                    <div className="message-body">{m.content}</div>
                  </details>
                ) : m.kind === "activity" ? (
                  <Activity content={m.content} />
                ) : (
                  <div className="message-body">
                    {m.role === "assistant" ? (
                      <Markdown text={m.content} />
                    ) : (
                      m.content
                    )}
                  </div>
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
        .map((p: any) =>
          p.data.kind === "question" ? (
            <UserQuestions
              key={p.id}
              request={p}
              reply={async (answers) => {
                await command(
                  "permission.reply",
                  { requestId: p.id, answers },
                  c.id,
                  c.version,
                );
                setData((current: any) => ({
                  ...current,
                  permissions: current.permissions.map((request: any) =>
                    request.id === p.id
                      ? { ...request, state: "answering" }
                      : request,
                  ),
                }));
              }}
            />
          ) : (
            <div className="permission" key={p.id} role="status">
              <strong>Provider request needs attention</strong>
              <p>
                This request could not be handled automatically. Stop this turn
                to clear the pending request; your conversation history stays
                available.
              </p>
              <small>Request type: {p.data.method ?? "Unknown"}</small>
              <button
                onClick={() =>
                  act("conversation.interrupt", {}, c.id, c.version)
                }
              >
                Stop this turn
              </button>
            </div>
          ),
        )}
      <div className="composer">
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
        {slashOpen && (
          <div className="slash-menu">
            <div className="help">Skills and commands</div>
            {slashLoading && <p role="status">Loading skills…</p>}
            {slashSelectionError && <p role="alert">{slashSelectionError}</p>}
            {slashError && (
              <p role="status">Skills could not load: {slashError}</p>
            )}
            {outer.provider !== "codex" && (
              <p className="help">
                Explicit skill attachments are available with Codex. Provider
                commands appear after this session advertises them.
              </p>
            )}
            <div
              role="listbox"
              id={"slash-options-" + outer.id}
              aria-label="Skills and commands"
            >
              {slashItems.map((item, index) => (
                <div
                  role="option"
                  id={"slash-option-" + outer.id + "-" + index}
                  key={item.id}
                  aria-selected={index === slashIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => chooseSlash(item)}
                >
                  <strong>/{item.name}</strong>
                  <span>{item.kind}</span>
                  <small>{item.description}</small>
                </div>
              ))}
            </div>
            {!slashItems.length && !slashLoading && (
              <p role="status">No matching skills or commands</p>
            )}
          </div>
        )}
        <textarea
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={slashOpen ? "slash-options-" + outer.id : undefined}
          aria-expanded={slashOpen}
          aria-activedescendant={
            slashOpen && slashItems[slashIndex]
              ? "slash-option-" + outer.id + "-" + slashIndex
              : undefined
          }
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
            setSlashDismissed(false);
            setSlashIndex(0);
            localStorage.setItem("draft:" + c.id, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              return;
            if (slashOpen) {
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashDismissed(true);
                return;
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((index) =>
                  slashItems.length
                    ? (index +
                        (e.key === "ArrowDown" ? 1 : -1) +
                        slashItems.length) %
                      slashItems.length
                    : 0,
                );
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                chooseSlash(slashItems[slashIndex]);
                return;
              }
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
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
                const next = skills.filter(
                  (selected) => selected.path !== skill.path,
                );
                setSkills(next);
                localStorage.setItem("skills:" + c.id, JSON.stringify(next));
                setSlashSelectionError("");
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
      <p className="subtle" aria-label="Ticket project">
        Project: {detail?.project?.id ?? t.projectId ?? "Not selected"}
        {detail?.project?.remote && <> · {detail.project.remote}</>}
      </p>
      {detail?.projectError && <p className="notice">{detail.projectError}</p>}
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
      ) : detail?.legacy?.management === "external" ? (
        <div className="notice">
          <strong>Externally managed legacy ticket</strong>
          <p>
            The app observes retained workers and keeps their history. It cannot
            start a duplicate worker for this ticket.
          </p>
          <p>{detail.adoption?.reason}</p>
          {detail.adoption?.eligible && (
            <button onClick={() => act("ticket.adopt", {}, t.id, t.version)}>
              Adopt queued ticket
            </button>
          )}
          {detail.legacy.completion && <p>{detail.legacy.completion}</p>}
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
      {detail?.legacy?.management === "app" && (
        <div className="notice">
          Imported legacy record · Adopted into app management.{" "}
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
      {detail?.legacy?.management !== "external" &&
        t.handling === "agent_managed" &&
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
            {detail?.legacy?.management !== "external" &&
              ["failed", "interrupted"].includes(a.state) && (
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
function Dashboard({
  version,
  cursor,
  heartbeat,
}: {
  version: number;
  cursor: any;
  heartbeat?: Heartbeat;
}) {
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
      inputMeasured: 0,
      outputMeasured: 0,
      runs: new Set(),
    };
    r.input += u.input ?? 0;
    r.output += u.output ?? 0;
    r.unknown ||= u.input == null || u.output == null;
    r.inputMeasured += Number(u.input != null);
    r.outputMeasured += Number(u.output != null);
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
          <strong>
            {all.some((r) => r.inputMeasured || r.outputMeasured)
              ? total.toLocaleString()
              : "Unavailable"}
          </strong>
          {all.some((r) => r.unknown) && <small>Partial coverage</small>}
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
                <td>
                  {r.inputMeasured ? r.input.toLocaleString() : "Unavailable"}
                </td>
                <td>
                  {r.outputMeasured ? r.output.toLocaleString() : "Unavailable"}
                </td>
                <td>
                  {!r.inputMeasured && !r.outputMeasured
                    ? "Unavailable"
                    : r.unknown
                      ? "Partial"
                      : "Measured"}
                </td>
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
      <HeartbeatStatus heartbeat={heartbeat} />
      <AccountDashboard api={api} />
      <h3>Cursor subscription</h3>
      <p>
        {cursor?.enabled && cursor?.mode === "subscription_usage"
          ? "Subscription usage reporting is enabled."
          : "Enable subscription usage reporting in Settings > Providers to use Cursor."}
      </p>
      <p className="help">
        Uses your signed-in Cursor account. Reported session tokens appear above
        when available. No account-wide token cap is enforced, and billing
        settings remain in Cursor.
      </p>
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
  const [provider, setProvider] = useState(c.provider);
  const [effort, setEffort] = useState(c.effort ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!mode) return;
    setModels([]);
    let live = true;
    setError("");
    void api(
      "catalog?topic=models&conversationId=" + c.id + "&provider=" + provider,
    )
      .then((d) => {
        if (live) {
          setModels(d.data);
          setSelected((current) =>
            d.data.some((m: any) => m.model === current)
              ? current
              : (d.data[0]?.model ?? ""),
          );
        }
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [mode, c.id, provider]);
  return (
    <>
      <button
        disabled={c.state !== "idle"}
        onClick={() => {
          setProvider(c.provider);
          setSelected(c.model);
          setEffort(c.effort ?? "");
          setMode("model");
        }}
      >
        Model
      </button>
      {c.role === "supervisor" && (
        <button
          disabled={c.state !== "idle"}
          onClick={() => {
            setProvider(c.provider);
            setSelected(c.model);
            setEffort(c.effort ?? "");
            setMode("restart");
          }}
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
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setEffort("");
                  }}
                >
                  {!models.length && <option value={c.model}>{c.model}</option>}
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Thinking effort
                <select
                  aria-label="Thinking effort"
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                  disabled={!models.length}
                >
                  <option value="">
                    Model default (
                    {models.find((m) => m.model === selected)
                      ?.defaultReasoningEffort ?? "loading"}
                    )
                  </option>
                  {(
                    models.find((m) => m.model === selected)
                      ?.supportedReasoningEfforts ?? []
                  ).map((e: any) => (
                    <option key={e.reasoningEffort} value={e.reasoningEffort}>
                      {e.reasoningEffort}
                    </option>
                  ))}
                </select>
              </label>
              <p className="subtle">
                {models
                  .find((m) => m.model === selected)
                  ?.supportedReasoningEfforts?.find(
                    (e: any) => e.reasoningEffort === effort,
                  )?.description ??
                  "The provider chooses the default effort for this model."}
              </p>
              <button
                className="primary"
                disabled={
                  !models.some((m) => m.model === selected) ||
                  c.state !== "idle"
                }
                onClick={async () => {
                  await act(
                    "conversation.model",
                    { model: selected, effort },
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
                This creates a fresh native conversation with the selected
                provider. Your previous chat, tickets, artifacts, and recorded
                context remain available.
              </p>
              <label>
                Provider
                <select
                  aria-label="New chat provider"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value as Conversation["provider"]);
                    setSelected("");
                    setEffort("");
                  }}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                  <option value="cursor">Cursor</option>
                </select>
              </label>
              {error && <p role="alert">{error}</p>}
              <label>
                Model
                <select
                  aria-label="New chat model"
                  value={selected}
                  disabled={!models.length}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setEffort("");
                  }}
                >
                  {!models.length && <option value="">No models loaded</option>}
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Thinking effort
                <select
                  aria-label="New chat thinking effort"
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                >
                  <option value="">Model default</option>
                  {(
                    models.find((m) => m.model === selected)
                      ?.supportedReasoningEfforts ?? []
                  ).map((e: any) => (
                    <option key={e.reasoningEffort} value={e.reasoningEffort}>
                      {e.reasoningEffort}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                Skills follow the selected provider's configuration. Previously
                loaded skill text isn't copied into the new conversation.
                Automatic control starts paused for the new chat.
              </p>
              <button
                className="primary"
                disabled={
                  !models.some((m) => m.model === selected) ||
                  c.state !== "idle"
                }
                onClick={async () => {
                  await act(
                    "conversation.restart",
                    { provider, model: selected, effort },
                    c.id,
                    c.version,
                  );
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
