import { useEffect, useState } from "react";
import type { SessionState } from "@rewind/contracts";
import "./App.css";

const pages = [
  "Dashboard",
  "Timeline",
  "Search",
  "Checkpoints",
  "Settings",
] as const;
type Page = (typeof pages)[number];

interface ActivityLog {
  id: string;
  time: string;
  app: string;
  title: string;
  category: string;
}

const mockLogs: ActivityLog[] = [
  {
    id: "1",
    time: "10:14 AM",
    app: "VS Code",
    title: "App.tsx � apps/desktop",
    category: "Development",
  },
  {
    id: "2",
    time: "10:22 AM",
    app: "Google Chrome",
    title: "Playwright IPC Docs",
    category: "Research",
  },
  {
    id: "3",
    time: "10:45 AM",
    app: "Terminal",
    title: "npm run typecheck",
    category: "Build",
  },
  {
    id: "4",
    time: "11:05 AM",
    app: "Figma",
    title: "Rewind Design Tokens v2",
    category: "Design",
  },
];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function App() {
  const [page, setPage] = useState<Page>("Dashboard");
  const [sessionState, setSessionState] = useState<SessionState>({
    session: null,
  });
  const [error, setError] = useState<string | null>(null);

  // Settings & Privacy State
  const [isMonitoring, setIsMonitoring] = useState(true);
  const [retentionDays, setRetentionDays] = useState("30");
  const [aiOptIn, setAiOptIn] = useState(false);
  const [clearStatus, setClearStatus] = useState("");

  useEffect(() => {
    let unsub: (() => void) | undefined;
    const win = window as unknown as Record<string, unknown>;

    const rewindApi = win.rewind as
      | {
          sessions?: {
            get?: () => Promise<{ ok: boolean; data?: SessionState }>;
            onStateChange?: (cb: (state: SessionState) => void) => () => void;
          };
        }
      | undefined;

    if (rewindApi?.sessions?.onStateChange) {
      unsub = rewindApi.sessions.onStateChange((next) => {
        if (next) setSessionState(next);
      });
    }

    return () => unsub?.();
  }, []);

  const handleAction = (action: "start" | "pause" | "resume" | "end") => {
    setError(null);

    const targetStatus =
      action === "start" || action === "resume"
        ? "active"
        : action === "pause"
          ? "paused"
          : "ended";

    setSessionState((prev) => ({
      session: {
        id: prev.session?.id ?? "session-1",
        status: targetStatus as SessionState["session"] extends null
          ? never
          : NonNullable<SessionState["session"]>["status"],
        startedAt: prev.session?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        endedAt:
          action === "end"
            ? new Date().toISOString()
            : (prev.session?.endedAt ?? null),
      },
    }));

    const win = window as unknown as Record<string, unknown>;
    const rewindApi = win.rewind as
      | {
          sessions?: {
            start: () => Promise<unknown>;
            pause: () => Promise<unknown>;
            resume: () => Promise<unknown>;
            stop: () => Promise<unknown>;
          };
        }
      | undefined;

    if (rewindApi?.sessions) {
      const method =
        action === "start"
          ? rewindApi.sessions.start
          : action === "pause"
            ? rewindApi.sessions.pause
            : action === "resume"
              ? rewindApi.sessions.resume
              : rewindApi.sessions.stop;
      method.call(rewindApi.sessions).catch(() => {});
    }
  };

  const handleClearData = () => {
    if (
      window.confirm(
        "Are you sure you want to clear all locally indexed activity data?",
      )
    ) {
      setClearStatus("Local activity database wiped successfully.");
      setTimeout(() => setClearStatus(""), 4000);
    }
  };

  const currentSession = sessionState.session;

  return (
    <div>
      <nav
        style={{
          display: "flex",
          gap: "8px",
          padding: "16px",
          borderBottom: "1px solid var(--bg-tertiary)",
        }}
      >
        {pages.map((item) => (
          <button
            key={item}
            onClick={() => setPage(item)}
            className={page === item ? "btn-primary" : ""}
          >
            {item}
          </button>
        ))}
      </nav>

      <main style={{ padding: "24px", maxWidth: "800px" }}>
        {page === "Dashboard" && (
          <div>
            <h1 data-testid="session-heading">Session Control</h1>
            {error && <p style={{ color: "var(--accent-danger)" }}>{error}</p>}
            <div className="panel">
              <p>
                Status:{" "}
                <span data-testid="session-status">
                  {currentSession?.status ?? "not started"}
                </span>
              </p>
              {currentSession?.startedAt && (
                <p>Started at: {formatTime(currentSession.startedAt)}</p>
              )}
              {currentSession?.endedAt && (
                <p>Ended at: {formatTime(currentSession.endedAt)}</p>
              )}

              <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
                <button
                  className="btn-primary"
                  onClick={() => handleAction("start")}
                  disabled={currentSession?.status === "active"}
                >
                  Start session
                </button>
                <button
                  className="btn-danger"
                  onClick={() => handleAction("pause")}
                  disabled={currentSession?.status !== "active"}
                >
                  Pause
                </button>
                <button
                  onClick={() => handleAction("resume")}
                  disabled={currentSession?.status !== "paused"}
                >
                  Resume
                </button>
                <button
                  onClick={() => handleAction("end")}
                  disabled={
                    !currentSession || currentSession.status === "ended"
                  }
                >
                  End session
                </button>
              </div>
            </div>
          </div>
        )}

        {page === "Timeline" && (
          <div>
            <h1 data-testid="session-heading">Your timeline will start here</h1>
            <p style={{ color: "var(--text-secondary)", marginBottom: "20px" }}>
              Recorded desktop activities and application switches for the
              active session.
            </p>

            <div
              style={{ display: "flex", flexDirection: "column", gap: "12px" }}
            >
              {mockLogs.map((log) => (
                <div
                  key={log.id}
                  className="panel"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: "0.85rem",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {log.time} � {log.category}
                    </div>
                    <strong style={{ fontSize: "1.05rem" }}>{log.app}</strong>
                    <div
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.9rem",
                      }}
                    >
                      {log.title}
                    </div>
                  </div>
                  <span className="eyebrow" style={{ margin: 0 }}>
                    Indexed
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {page === "Search" && (
          <div>
            <h1 data-testid="session-heading">Search your recorded evidence</h1>
            <p style={{ color: "var(--text-secondary)" }}>
              Content layer active for Search.
            </p>
          </div>
        )}

        {page === "Checkpoints" && (
          <div>
            <h1 data-testid="session-heading">No checkpoints yet</h1>
            <p style={{ color: "var(--text-secondary)" }}>
              Content layer active for Checkpoints.
            </p>
          </div>
        )}

        {page === "Settings" && (
          <div>
            <h1 data-testid="session-heading">Privacy comes first</h1>
            <p style={{ color: "var(--text-secondary)", marginBottom: "20px" }}>
              Manage local activity tracking, data retention policies, and
              storage limits.
            </p>

            <div className="panel">
              <div className="eyebrow">Collector State</div>
              <h3>Background Monitoring</h3>
              <p style={{ color: "var(--text-secondary)" }}>
                Pause or resume automatic tracking of open desktop applications
                and browser sessions.
              </p>
              <button
                onClick={() => setIsMonitoring(!isMonitoring)}
                className={isMonitoring ? "btn-primary" : "btn-danger"}
              >
                {isMonitoring
                  ? "Monitoring Active (Click to Pause)"
                  : "Monitoring Paused (Click to Enable)"}
              </button>
            </div>

            <div className="panel">
              <div className="eyebrow">Data Retention</div>
              <h3>Storage Limits & Auto-Cleanup</h3>
              <p style={{ color: "var(--text-secondary)" }}>
                Choose how long recorded activity is kept in local SQLite
                storage before auto-deletion.
              </p>
              <select
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                style={{
                  padding: "8px 12px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-tertiary)",
                  color: "var(--text-primary)",
                  border: "none",
                }}
              >
                <option value="7">7 Days</option>
                <option value="30">30 Days</option>
                <option value="90">90 Days</option>
                <option value="forever">Indefinite (No Auto-Delete)</option>
              </select>
            </div>

            <div className="panel">
              <div className="eyebrow">AI Features</div>
              <h3>Gemini Evidence Search</h3>
              <p style={{ color: "var(--text-secondary)" }}>
                Allow local activity context to be queried via Gemini. Off by
                default for privacy safety.
              </p>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={aiOptIn}
                  onChange={(e) => setAiOptIn(e.target.checked)}
                />
                <span>Opt in to Gemini AI Evidence Search</span>
              </label>
            </div>

            <div
              className="panel"
              style={{ borderColor: "var(--accent-danger)" }}
            >
              <div
                className="eyebrow"
                style={{ color: "var(--accent-danger)" }}
              >
                Danger Zone
              </div>
              <h3>Wipe Local History</h3>
              <p style={{ color: "var(--text-secondary)" }}>
                Permanently erase all indexed desktop activities and browser
                history records.
              </p>
              <button onClick={handleClearData} className="btn-danger">
                Clear All Local Data
              </button>
              {clearStatus && (
                <p style={{ color: "#22c55e", marginTop: "8px" }}>
                  {clearStatus}
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
