import { useEffect, useRef, useState } from "react";
import type { SessionAction, SessionState } from "@rewind/contracts";
import {
  RecordedHistory,
  RecordingPreferences,
  useRecordingRuntime,
} from "./recording";

const pages = [
  "Dashboard",
  "Timeline",
  "Search",
  "Checkpoints",
  "Settings",
] as const;
type Page = (typeof pages)[number];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function App() {
  const { runtime, runtimeError } = useRecordingRuntime();
  const [page, setPage] = useState<Page>("Dashboard");
  const [state, setState] = useState<SessionState>({ session: null });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<Exclude<
    SessionAction,
    "get"
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionEvents = useRef(0);
  useEffect(() => {
    let mounted = true;

    if (!window.rewind?.sessions) {
      setError("Could not reach the desktop session service.");
      setReady(false);
      return;
    }

    const unsubscribe = window.rewind.sessions.onChanged((next) => {
      if (mounted) {
        sessionEvents.current++;
        setState(next);
      }
    });

    const observedEvents = sessionEvents.current;
    void window.rewind.sessions
      .get()
      .then((result) => {
        if (!mounted) return;

        if (result.ok) {
          if (sessionEvents.current === observedEvents) setState(result.value);
        } else {
          setError(result.error.message);
        }

        setReady(result.ok);
      })
      .catch(() => {
        if (mounted) {
          setError("Could not reach the desktop session service.");
          setReady(false);
        }
      });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function run(action: Exclude<SessionAction, "get">): Promise<void> {
    if (busy || !ready) return;

    setBusy(true);
    setPendingAction(action);
    setError(null);
    const observedEvents = sessionEvents.current;

    try {
      const result = await window.rewind.sessions[action]();

      if (result.ok) {
        if (sessionEvents.current === observedEvents) setState(result.value);
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("Could not reach the desktop session service.");
    } finally {
      setBusy(false);
      setPendingAction(null);
    }
  }
  async function retryConnection(): Promise<void> {
    setReady(false);
    setError(null);
    const observedEvents = sessionEvents.current;

    try {
      if (window.rewind?.runtime) {
        const retried = await window.rewind.runtime.retry();
        if (!retried.ok) {
          setError(retried.error.message);
          return;
        }
      }
      const result = await window.rewind.sessions.get();

      if (result.ok) {
        if (sessionEvents.current === observedEvents) setState(result.value);
        setReady(true);
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("Could not reach the desktop session service.");
    }
  }
  const session = state.session;
  const status = session?.status ?? "not started";
  const canStart = !session || session.status === "ended";
  const serviceReady =
    ready && (!window.rewind?.runtime || runtime?.service === "ready");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ↶
          </span>
          <span>
            Rewind<small>WORK SESSION MEMORY</small>
          </span>
        </div>

        <nav aria-label="Main navigation">
          {pages.map((item, i) => (
            <button
              key={item}
              className={page === item ? "nav-item selected" : "nav-item"}
              aria-current={page === item ? "page" : undefined}
              onClick={() => setPage(item)}
            >
              <span className="nav-number" aria-hidden="true">
                0{i + 1}
              </span>
              {item}
            </button>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="privacy-dot" />
          <span data-testid="collection-status">
            Collection {runtime?.collection ?? "off"}
          </span>
          <p>
            {runtime?.collection === "active"
              ? "Windows activity is being recorded."
              : runtime?.collection === "unavailable"
                ? "Recording service requires attention."
                : "No active recording authorization."}
            <br />
            Cloud AI is disabled.
          </p>
        </div>

        <div className="build-label">v0.1 · Development build</div>
      </aside>

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">YOUR WORK, WITH CONTEXT</p>
            <h1>{page}</h1>
          </div>

          <span className="badge">
            {runtime?.synthetic
              ? "Synthetic verification mode"
              : "Local development"}
          </span>
        </header>

        <div className="notice">
          <strong>
            {runtime?.secureStorage
              ? "Encrypted local history"
              : "Secure storage unavailable"}
          </strong>
          <span>
            Windows recording requires approval for this launch and an active
            session. Cloud AI, browser visits, folder protection and recovery
            are unavailable.
          </span>
        </div>

        {(runtimeError || runtime?.error) && (
          <div className="error" role="alert">
            <p>{runtimeError ?? runtime?.error?.message}</p>
            <button onClick={() => void retryConnection()}>
              Reconnect recording service
            </button>
          </div>
        )}

        {error && (
          <div className="error" role="alert">
            <p>{error}</p>

            {!ready && (
              <button type="button" onClick={() => void retryConnection()}>
                Retry connection
              </button>
            )}
          </div>
        )}

        {page === "Dashboard" && (
          <>
            <section
              className="panel session-panel"
              aria-labelledby="session-heading"
            >
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">SESSION CONTROLS</p>
                  <h2 id="session-heading">Dashboard</h2>
                </div>

                <span
                  className={`status status-${session?.status ?? "none"}`}
                  data-testid="session-status"
                  role="status"
                >
                  {ready ? status : error ? "connection error" : "loading"}
                </span>
              </div>

              <p>
                Starting without permission records no activity. Approve Windows
                activity below before starting or resuming a recording session.
              </p>

              <div className="controls" aria-label="Session controls">
                <button
                  className="primary"
                  onClick={() => void run("start")}
                  disabled={!serviceReady || busy || !canStart}
                  aria-busy={pendingAction === "start"}
                >
                  {pendingAction === "start" ? "Starting..." : "Start session"}
                </button>

                <button
                  onClick={() => void run("pause")}
                  disabled={!ready || busy || status !== "active"}

                  aria-busy={pendingAction === "pause"}
                >
                  {pendingAction === "pause" ? "Pausing..." : "Pause"}
                </button>

                <button
                  onClick={() => void run("resume")}
                  disabled={!serviceReady || busy || status !== "paused"}

                  aria-busy={pendingAction === "resume"}
                >
                  {pendingAction === "resume" ? "Resuming..." : "Resume"}
                </button>

                <button
                  className="end-button"
                  onClick={() => void run("end")}
                  disabled={!ready || busy || canStart}
                  aria-busy={pendingAction === "end"}
                >
                  {pendingAction === "end" ? "Ending..." : "End session"}
                </button>
              </div>

              <div className="session-meta">
                {session ? (
                  <>
                    Started {formatTime(session.startedAt)}
                    {session.endedAt && (
                      <> · Ended {formatTime(session.endedAt)}</>
                    )}
                  </>
                ) : (
                  "No session has been started."
                )}
              </div>
            </section>

            <RecordingPreferences runtime={runtime} />

            <div className="card-grid">
              <section className="panel">
                <p className="eyebrow">ACTIVITY HISTORY</p>
                <h2>Timeline</h2>

                <p>
                  View recorded Windows observations, capture gaps and previous
                  sessions from encrypted storage.
                </p>

                <button
                  className="text-button"
                  onClick={() => setPage("Timeline")}
                >
                  View timeline <span aria-hidden="true">→</span>
                </button>
              </section>

              <section className="panel">
                <p className="eyebrow">FILE PROTECTION</p>
                <h2>No folders protected</h2>

                <p>
                  Folder selection, saved versions, and reviewed recovery are
                  planned for a later milestone.
                </p>

                <span className="subtle-label">
                  Not available in this build
                </span>
              </section>
            </div>

            <p className="footnote">
              Sessions and history persist. Closing the window ends the session
              and quits Rewind. Recording permission expires on restart.
            </p>
          </>
        )}

        {page === "Timeline" && <RecordedHistory runtime={runtime} />}

        {page === "Search" && <RecordedHistory runtime={runtime} search />}

        {page === "Checkpoints" && (
          <EmptyState
            title="No checkpoints yet"
            description="Future checkpoints will group captured file versions, websites, and project references. They cannot restore arbitrary unsaved application state."
          />
        )}

        {page === "Settings" && (
          <section className="panel">
            <h2>Privacy comes first</h2>
            <RecordingPreferences runtime={runtime} />
            <div className="notice">
              <strong>Privacy settings</strong>
              <span>
                Recording permission and application exclusions above are saved
                by the engine. Other capabilities below remain unavailable.
              </span>
            </div>

            <p>
              History is encrypted and protected by this Windows account.
              Automatic cleanup, full quota management and history deletion are
              not implemented yet. Record only nonsensitive development
              activity.
            </p>

            <dl className="settings-list">
              <div>
                <dt>Activity collection</dt>
                <dd>{runtime?.collection ?? "unavailable"}</dd>
              </div>

              <div>
                <dt>Cloud Gemini</dt>
                <dd>Off · unavailable</dd>
              </div>

              <div>
                <dt>Article extraction</dt>
                <dd>Off · unavailable</dd>
              </div>

              <div>
                <dt>Retention</dt>
                <dd>
                  <select
                    aria-label="Data retention period"
                    defaultValue="72"
                    disabled
                  >
                    <option value="24">24 hours</option>
                    <option value="48">48 hours</option>
                    <option value="72">72 hours</option>
                    <option value="168">7 days</option>
                  </select>
                  <span className="subtle-label"> Preview only</span>
                </dd>
              </div>

              <div>
                <dt>Storage limit</dt>
                <dd>
                  <select aria-label="Storage limit" defaultValue="2" disabled>
                    <option value="1">1 GiB</option>
                    <option value="2">2 GiB</option>
                    <option value="5">5 GiB</option>
                    <option value="10">10 GiB</option>
                  </select>
                  <span className="subtle-label"> Preview only</span>
                </dd>
              </div>

              <div>
                <dt>History / snapshots</dt>
                <dd>
                  {runtime?.secureStorage
                    ? "Encrypted history available"
                    : "History unavailable"}{" "}
                  / snapshots unavailable
                </dd>
              </div>
            </dl>

            <p className="footnote">
              No keystrokes, clipboard contents, screenshots, or private browser
              activity is captured. Browser window titles are skipped.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="panel empty-state">
      <div className="empty-symbol" aria-hidden="true">
        ↶
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      <span className="subtle-label">Planned feature · no demo activity</span>
    </section>
  );
}
