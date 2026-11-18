import { useEffect, useRef, useState } from "react";
import type { SessionAction, SessionState } from "@rewind/contracts";
import {
  RecordedHistory,
  RecordingPreferences,
  useRecordingRuntime,
} from "./recording";

import { StorageManagement } from "./storage-management";
import { Files } from "./files";
import { Checkpoints } from "./checkpoints";
import { BrowserSettings } from "./browser-settings";

const pages = [
  "Dashboard",
  "Timeline",
  "Search",
  "Files",
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
              ? runtime.filePermission || runtime.browserPermission
                ? "Approved sources are enabled; see Files and Settings for progress."
                : "Windows activity recording is enabled."
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
            Windows activity, selected folders and browser metadata need
            separate approval and an active session. Browser recording also
            needs the extension's approval. Verified file versions can be saved
            as separate copies. Cloud AI is disabled.
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
                <h2>Saved file versions</h2>

                <p>
                  Select folders and approve capture to preserve supported saved
                  bytes. Inspect capture progress and verified versions in
                  Files.
                </p>

                <button
                  className="text-button"
                  onClick={() => setPage("Files")}
                >
                  Open file protection
                </button>
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
        {page === "Files" && <Files runtime={runtime} />}

        {page === "Checkpoints" && <Checkpoints runtime={runtime} />}

        {page === "Settings" && (
          <section className="panel">
            <h2>Privacy comes first</h2>
            <RecordingPreferences runtime={runtime} />
            <BrowserSettings runtime={runtime} />
            <div className="notice">
              <strong>Privacy settings</strong>
              <span>
                Recording permission and application exclusions above are saved
                by the engine. Manage encrypted history below and protected
                folders in Files.
              </span>
            </div>

            <StorageManagement runtime={runtime} />
            <p>
              Cloud Gemini and article extraction remain off and unavailable.
            </p>

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
