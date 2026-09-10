import React, { useEffect, useState } from "react";

type ProviderStatus = {
  provider: string;
  installed: boolean;
  authenticated: boolean | null;
  message: string;
  login: { state: string };
};
export function ProviderSettings({
  api,
  post,
  cursorReason,
}: {
  api: (url: string) => Promise<any>;
  post: (url: string) => Promise<any>;
  cursorReason: string;
}) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const refresh = async () => {
    const result = await api("providers");
    setProviders(result.providers);
    setError("");
  };
  useEffect(() => {
    let live = true;
    const load = () =>
      api("providers")
        .then((result) => {
          if (live) {
            setProviders(result.providers);
            setError("");
          }
        })
        .catch((e) => live && setError(String(e)));
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const login = async (provider: string, action: string) => {
    setBusy(provider);
    setError("");
    try {
      const status = await post(`providers/${provider}/${action}`);
      setProviders((current) =>
        current.map((p) => (p.provider === provider ? status : p)),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <section aria-label="Providers" className="provider-settings">
      <h3>Providers</h3>
      <p className="help">
        Sign in with your provider account. Authentication opens in your default
        browser and stays in the provider's native credential store.
      </p>
      {error && <p role="alert">{error}</p>}
      {!providers.length && !error && (
        <p role="status">Checking sign-in status…</p>
      )}
      {providers.map((p) => (
        <article key={p.provider} className="provider-card">
          <div className="provider-heading">
            <strong>{p.provider === "claude" ? "Claude" : "Cursor"}</strong>
            <span>
              {p.authenticated === true
                ? "Signed in"
                : p.authenticated === false
                  ? "Not signed in"
                  : "Status unavailable"}
            </span>
          </div>
          <p role="status">{p.message}</p>
          {p.provider === "cursor" && <p className="help">{cursorReason}</p>}
          {p.login.state === "pending" ? (
            <button
              disabled={busy === p.provider}
              onClick={() => void login(p.provider, "cancel")}
            >
              Cancel {p.provider === "claude" ? "Claude" : "Cursor"} sign-in
            </button>
          ) : (
            <button
              disabled={!p.installed || busy === p.provider}
              onClick={() => void login(p.provider, "login")}
            >
              {p.authenticated ? "Sign in again to " : "Sign in to "}
              {p.provider === "claude" ? "Claude" : "Cursor"}
            </button>
          )}
        </article>
      ))}
      <button onClick={() => void refresh().catch((e) => setError(String(e)))}>
        Refresh sign-in status
      </button>
    </section>
  );
}
