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
import { AssistantSettings } from "./assistant";
import {
  HouseIcon,
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
  FolderSimpleIcon,
  BookmarkSimpleIcon,
  SlidersHorizontalIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import { Mascot } from "./Mascot";
import { usePresentation } from "./presentation";
import { RecordingSetup } from "./recording-setup";

const pages = [
  "Dashboard",
  "Timeline",
  "Search",
  "Files",
  "Checkpoints",
  "Settings",
] as const;
type Page = (typeof pages)[number];
const pageIcons = [
  HouseIcon,
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
  FolderSimpleIcon,
  BookmarkSimpleIcon,
  SlidersHorizontalIcon,
];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function App() {
  const { runtime, runtimeError } = useRecordingRuntime();
  const [page, setPage] = useState<Page>("Dashboard");
  const presentation = usePresentation();
  const lastNavigation = useRef(-1);
  useEffect(() => {
    const intent = presentation?.navigation;
    if (intent && intent.revision > lastNavigation.current) {
      lastNavigation.current = intent.revision;
      setPage(intent.page);
    }
  }, [presentation?.navigation]);
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
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <Mascot className="brand-mark" />
          <span>
            Rewind<small>A LITTLE LESS LOST.</small>
          </span>
        </div>

        <nav aria-label="Main navigation">
          {pages.map((item, i) => {
            const Icon = pageIcons[i] ?? HouseIcon;
            return (
              <button
                key={item}
                className={page === item ? "nav-item selected" : "nav-item"}
                aria-current={page === item ? "page" : undefined}
                onClick={() => setPage(item)}
              >
                <Icon
                  size={21}
                  weight={page === item ? "duotone" : "regular"}
                  aria-hidden="true"
                />
                {item}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-note">
          <span className="privacy-dot" />
          <span data-testid="collection-status" role="status">
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
            {runtime?.assistant.permission
              ? "Cloud questions approved."
              : "Cloud approval is off."}
          </p>
        </div>

        <div className="build-label">
          <ShieldCheckIcon size={15} aria-hidden="true" /> Private by design ·
          v0.1 beta
        </div>
      </aside>

      <main id="main-content" tabIndex={-1}>
        <header className="page-header">
          <div>
            <p className="eyebrow">YOUR WORK, WITH CONTEXT</p>
            <h1>{page}</h1>
          </div>

          <span className="badge">
            {runtime?.synthetic
              ? "Synthetic verification mode"
              : "On your device"}
          </span>
        </header>

        <div className="notice secure-summary">
          <ShieldCheckIcon size={19} aria-hidden="true" />
          <strong>
            {!runtime || runtime.service === "starting"
              ? "Connecting to secure history"
              : runtime.secureStorage
                ? "Encrypted local history"
                : "Secure storage unavailable"}
          </strong>
          <span>
            {runtime?.assistant.permission
              ? "Cloud questions approved · Each question needs a sharing review"
              : "Cloud off · You choose what Rewind remembers"}
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
            <RecordingSetup runtime={runtime} />
            <section
              className="panel session-panel"
              aria-labelledby="session-heading"
            >
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">SESSION CONTROLS</p>
                  <h2 id="session-heading">Stay in your flow.</h2>
                  <p className="session-greeting">
                    A good place to pick things up.
                  </p>
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
                {runtime?.automaticRecording
                  ? "Your approved sources record during active sessions. Pause or End stops capture."
                  : "Use the one-time setup above to start recording automatically, or use manual source controls below."}
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

            <div className="card-grid">
              <section className="panel">
                <ClockCounterClockwiseIcon
                  className="card-icon"
                  size={24}
                  weight="duotone"
                  aria-hidden="true"
                />
                <p className="eyebrow">ACTIVITY HISTORY</p>
                <h2>Timeline</h2>

                <p>
                  Find your way back through recorded moments and past sessions.
                </p>

                <button
                  className="text-button"
                  onClick={() => setPage("Timeline")}
                >
                  View timeline <span aria-hidden="true">→</span>
                </button>
              </section>

              <section className="panel">
                <FolderSimpleIcon
                  className="card-icon"
                  size={24}
                  weight="duotone"
                  aria-hidden="true"
                />
                <p className="eyebrow">FILE PROTECTION</p>
                <h2>Saved file versions</h2>

                <p>
                  Revisit captured versions and recover a verified copy when you
                  need it.
                </p>

                <button
                  className="text-button"
                  onClick={() => setPage("Files")}
                >
                  Open file protection
                </button>
              </section>
            </div>

            <details className="panel" open={!runtime?.automaticRecording}>
              <summary>Advanced recording controls and exclusions</summary>
              <RecordingPreferences runtime={runtime} />
            </details>

            <p className="footnote">
              Minimize to keep Rewind within reach in the notch. Closing the
              window ends the session and quits. Automatic recording restarts
              when you next open Rewind if you enabled it.
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
            <RecordingSetup runtime={runtime} />
            <RecordingPreferences runtime={runtime} />
            <BrowserSettings runtime={runtime} />
            <AssistantSettings runtime={runtime} />
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
              Article extraction remains off and unavailable. Gemini requires
              separate approval and a reviewed question in Search.
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
