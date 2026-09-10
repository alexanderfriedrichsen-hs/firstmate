import React, { useEffect, useState } from "react";
export type Heartbeat = {
  enabled: boolean;
  intervalMinutes: number;
  lastTickAt?: string;
  lastCheckAt?: string;
  nextCheckAt?: string;
  lastWakeAt?: string;
  lastAckAt?: string;
  pendingWakeId?: string;
  status: string;
  summary: string;
  issues: Array<{ code: string; message: string }>;
};
function time(value?: string) {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unavailable" : date.toLocaleString();
}
export function useHeartbeatHealth(heartbeat?: Heartbeat) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  return heartbeat?.enabled &&
    heartbeat.lastTickAt &&
    now - Date.parse(heartbeat.lastTickAt) > 60000
    ? "stale"
    : heartbeat?.status;
}
export function HeartbeatStatus({
  heartbeat,
  compact = false,
}: {
  heartbeat?: Heartbeat;
  compact?: boolean;
}) {
  const status = useHeartbeatHealth(heartbeat);
  if (!heartbeat) return <p role="status">Heartbeat status is unavailable.</p>;
  const stale = status === "stale";
  const label: Record<string, string> = {
    disabled: "Disabled",
    paused: "Paused",
    waiting: "Waiting",
    busy: "Firstmate is busy",
    healthy: "Healthy",
    attention: "Needs attention",
    stale: "Heartbeat overdue",
  };
  return (
    <section className="heartbeat-status" aria-label="Heartbeat status">
      <div className="provider-heading">
        <h3>Heartbeat</h3>
        <span>{label[status ?? ""] ?? "Status unavailable"}</span>
      </div>
      <p>
        {stale
          ? heartbeat.lastTickAt
            ? "The runtime has not reported a heartbeat in over a minute. Check that Firstmate is running."
            : "No runtime heartbeat has been received yet. Check that Firstmate is running."
          : heartbeat.summary}
      </p>
      {!compact && (
        <dl className="heartbeat-times">
          <div>
            <dt>Last fleet check</dt>
            <dd>{time(heartbeat.lastCheckAt)}</dd>
          </div>
          <div>
            <dt>Next fleet check</dt>
            <dd>
              {heartbeat.enabled ? time(heartbeat.nextCheckAt) : "Disabled"}
            </dd>
          </div>
          <div>
            <dt>Last queued heartbeat</dt>
            <dd>{time(heartbeat.lastWakeAt)}</dd>
          </div>
          <div>
            <dt>Last acknowledged wake</dt>
            <dd>{time(heartbeat.lastAckAt)}</dd>
          </div>
        </dl>
      )}
      {heartbeat.issues?.length > 0 && (
        <div className="notice" role="status">
          <ul>
            {heartbeat.issues.map((issue) => (
              <li key={issue.code}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
export function HeartbeatSettings({
  heartbeat,
  save,
}: {
  heartbeat?: Heartbeat;
  save: (value: { enabled: boolean; intervalMinutes: number }) => Promise<any>;
}) {
  const [enabled, setEnabled] = useState(heartbeat?.enabled ?? false);
  const [interval, setIntervalValue] = useState(
    String(heartbeat?.intervalMinutes ?? 10),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setEnabled(heartbeat?.enabled ?? false);
    setIntervalValue(String(heartbeat?.intervalMinutes ?? 10));
  }, [heartbeat?.enabled, heartbeat?.intervalMinutes]);
  const minutes = Number(interval);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 120;
  return (
    <section className="heartbeat-settings">
      <HeartbeatStatus heartbeat={heartbeat} />
      <p className="help">
        Heartbeat checks your fleet on a schedule and wakes Firstmate when
        needed. Automatic work respects dispatch pauses, manual mode, and
        pending questions.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid || busy) return;
          setBusy(true);
          setError("");
          setSaved(false);
          try {
            await save({ enabled, intervalMinutes: minutes });
            setSaved(true);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || !heartbeat}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setSaved(false);
            }}
          />
          Enable heartbeat
        </label>
        <label>
          Check every (minutes)
          <input
            type="number"
            min="1"
            max="120"
            step="1"
            value={interval}
            disabled={busy || !heartbeat}
            onChange={(e) => {
              setIntervalValue(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy || !valid || !heartbeat} className="primary">
          {busy ? "Saving heartbeat…" : "Save heartbeat"}
        </button>
        {saved && <p role="status">Heartbeat settings saved.</p>}
      </form>
    </section>
  );
}
