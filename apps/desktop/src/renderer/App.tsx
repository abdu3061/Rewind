import { useEffect, useRef, useState } from "react";
import type { SessionAction, SessionState } from "@rewind/contracts";
import {
  RecordedHistory,
  RecordingPreferences,
  useRecordingRuntime,
} from "./recording";

import { Files } from "./files";
import { Checkpoints } from "./checkpoints";
import { RecentOverview } from "./home";
import { Settings, type SettingsTab } from "./settings";
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

const collectionLabel = {
  off: "off",
  starting: "starting",
  active: "on",
  stopping: "stopping",
  unavailable: "unavailable",
} as const;

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function App() {
  const { runtime, runtimeError } = useRecordingRuntime();
  const [page, setPage] = useState<Page>("Dashboard");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("Recording");
  const [focusVersion, setFocusVersion] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  const presentation = usePresentation();
  const lastNavigation = useRef(-1);
  useEffect(() => {
    const intent = presentation?.navigation;
    if (intent && intent.revision > lastNavigation.current) {
      lastNavigation.current = intent.revision;
      // The notch opens Settings to manage recording permissions.
      if (intent.page === "Settings") setSettingsTab("Recording");
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
  const collection = runtime?.collection ?? "off";
  const sessionHeading = !session
    ? "Ready when you are"
    : session.status === "active"
      ? "Session in progress"
      : session.status === "paused"
        ? "Session paused"
        : "Session ended";
  // Setup leads the page until automatic recording is on and healthy.
  const needsSetup =
    !runtime?.automaticRecording ||
    !runtime.preferences.collectionConsent ||
    !runtime.filePermission;

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

        <div className={`sidebar-status collection-${collection}`}>
          <span className="status-dot" aria-hidden="true" />
          <span data-testid="collection-status" role="status">
            Recording {collectionLabel[collection]}
          </span>
          {runtime?.assistant.permission && <small>Cloud AI on</small>}
        </div>

        <div className="build-label">
          <ShieldCheckIcon size={15} aria-hidden="true" /> Encrypted on this PC
          · v0.1 beta
        </div>
      </aside>

      <main id="main-content" tabIndex={-1}>
        <header className="page-header">
          <h1>{page}</h1>
          {runtime?.synthetic && (
            <span className="badge">Synthetic verification mode</span>
          )}
        </header>

        {(!runtime ||
          runtime.service === "starting" ||
          !runtime.secureStorage) && (
          <div className="notice secure-summary">
            <ShieldCheckIcon size={19} aria-hidden="true" />
            <strong>
              {!runtime || runtime.service === "starting"
                ? "Connecting to secure history…"
                : "Secure storage unavailable"}
            </strong>
          </div>
        )}

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
          <div className="stack">
            {needsSetup && <RecordingSetup runtime={runtime} />}
            <section
              className="panel session-panel"
              aria-labelledby="session-heading"
            >
              <div className="panel-heading">
                <h2 id="session-heading">{sessionHeading}</h2>
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
                  ? "Approved sources record while a session is active."
                  : "Start a session to record, or use the setup above to start automatically."}
              </p>

              <div className="controls" aria-label="Session controls">
                {canStart ? (
                  <button
                    className="primary"
                    onClick={() => void run("start")}
                    disabled={!serviceReady || busy}
                    aria-busy={pendingAction === "start"}
                  >
                    {pendingAction === "start"
                      ? "Starting..."
                      : "Start session"}
                  </button>
                ) : (
                  <>
                    {status === "paused" ? (
                      <button
                        className="primary"
                        onClick={() => void run("resume")}
                        disabled={!serviceReady || busy}
                        aria-busy={pendingAction === "resume"}
                      >
                        {pendingAction === "resume" ? "Resuming..." : "Resume"}
                      </button>
                    ) : (
                      <button
                        onClick={() => void run("pause")}
                        disabled={!ready || busy}
                        aria-busy={pendingAction === "pause"}
                      >
                        {pendingAction === "pause" ? "Pausing..." : "Pause"}
                      </button>
                    )}
                    <button
                      className="end-button"
                      onClick={() => void run("end")}
                      disabled={!ready || busy}
                      aria-busy={pendingAction === "end"}
                    >
                      {pendingAction === "end" ? "Ending..." : "End session"}
                    </button>
                  </>
                )}
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

            {!runtime?.automaticRecording && (
              <RecordingPreferences runtime={runtime} compact />
            )}

            <RecentOverview
              runtime={runtime}
              onNavigate={setPage}
              onOpenVersion={(id) => {
                setFocusVersion((current) => ({
                  id,
                  revision: (current?.revision ?? 0) + 1,
                }));
                setPage("Files");
              }}
            />

            {!needsSetup && <RecordingSetup runtime={runtime} />}

            <p className="footnote">
              Minimize to keep Rewind in the notch. Closing the window ends the
              session and quits Rewind.
            </p>
          </div>
        )}

        {page === "Timeline" && <RecordedHistory runtime={runtime} />}

        {page === "Search" && <RecordedHistory runtime={runtime} search />}
        {page === "Files" && (
          <Files runtime={runtime} focusVersion={focusVersion} />
        )}

        {page === "Checkpoints" && <Checkpoints runtime={runtime} />}

        {page === "Settings" && (
          <Settings
            runtime={runtime}
            tab={settingsTab}
            onTab={setSettingsTab}
          />
        )}
      </main>
    </div>
  );
}
