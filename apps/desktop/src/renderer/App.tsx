import { useEffect, useState } from "react";
import type { SessionAction, SessionState } from "@rewind/contracts";

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
  const [page, setPage] = useState<Page>("Dashboard");
  const [state, setState] = useState<SessionState>({ session: null });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<Exclude<
    SessionAction,
    "get"
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timelineSearch, setTimelineSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(
    null,
  );
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const searchHasResults = [
    "visual studio code",
    "application",
    "react project",
    "chrome",
    "website",
    "react documentation",
    "project notes",
    "file",
    "project document",
  ].some((text) => text.includes(searchQuery.toLowerCase().trim()));
  const timelineHasResults = [
    "visual studio code",
    "application",
    "react project",
    "chrome",
    "website",
    "react documentation",
    "project notes",
    "file",
    "project document",
  ].some((text) => text.includes(timelineSearch.toLowerCase().trim()));

  useEffect(() => {
    let mounted = true;

    const unsubscribe = window.rewind.sessions.onChanged((next) => {
      if (mounted) {
        setState(next);
      }
    });

    void window.rewind.sessions
      .get()
      .then((result) => {
        if (!mounted) return;

        if (result.ok) {
          setState(result.value);
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

    try {
      const result = await window.rewind.sessions[action]();

      if (result.ok) {
        setState(result.value);
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

    try {
      const result = await window.rewind.sessions.get();

      if (result.ok) {
        setState(result.value);
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
          Collection off
          <p>
            Nothing is being monitored.
            <br />
            Cloud AI is disabled.
          </p>
        </div>

        <div className="build-label">v0.1 · Development starter</div>
      </aside>

      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">YOUR WORK, WITH CONTEXT</p>
            <h1>{page}</h1>
          </div>

          <span className="badge">Local development</span>
        </header>

        <div className="notice">
          <strong>Initialization build</strong>
          <span>
            Session controls work in memory. Activity collection, file
            protection, and history storage are not connected.
          </span>
        </div>

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
                Start a session to try the lifecycle. Starting does not enable
                monitoring or protect files in this build.
              </p>

              <div className="controls" aria-label="Session controls">
                <button
                  className="primary"
                  onClick={() => void run("start")}
                  disabled={!ready || busy || !canStart}
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
                  disabled={!ready || busy || status !== "paused"}

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
                  "No session started in this app process."
                )}
              </div>
            </section>

            <div className="card-grid">
              <section className="panel">
                <p className="eyebrow">ACTIVITY HISTORY</p>
                <h2>Timeline</h2>

                <p>
                  Timeline events will appear here once collectors and encrypted
                  storage are ready.
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
              Sessions reset when Rewind exits. Closing the window quits this
              starter.
            </p>
          </>
        )}

        {page === "Timeline" && (
          <section className="panel">
            <p className="eyebrow">ACTIVITY TIMELINE</p>
            <h2>Your work activity</h2>

            <p>
              See the applications, websites, and files used during your work
              sessions.
            </p>

            <div className="notice">
              <strong>Preview only</strong>
              <span>
                These are example activities for the interface design. Real
                activity collection is not connected yet.
              </span>
            </div>

            <input
              type="search"
              className="timeline-search"
              placeholder="Search activities..."
              aria-label="Search timeline activities"
              value={timelineSearch}
              onChange={(e) => setTimelineSearch(e.target.value)}
            />
            <div className="timeline-list">
              {["visual studio code", "application", "react project"].some(
                (text) => text.includes(timelineSearch.toLowerCase().trim()),
              ) && (
                <div className="timeline-card">
                  <span className="timeline-time">10:30 AM</span>
                  <div>
                    <h3>Visual Studio Code</h3>
                    <p>Application · Working on a React project</p>
                  </div>
                </div>
              )}

              {["chrome", "website", "react documentation"].some((text) =>
                text.includes(timelineSearch.toLowerCase().trim()),
              ) && (
                <div className="timeline-card">
                  <span className="timeline-time">10:15 AM</span>
                  <div>
                    <h3>Chrome</h3>
                    <p>Website · Reading React documentation</p>
                  </div>
                </div>
              )}

              {["project notes", "file", "project document"].some((text) =>
                text.includes(timelineSearch.toLowerCase().trim()),
              ) && (
                <div className="timeline-card">
                  <span className="timeline-time">09:45 AM</span>
                  <div>
                    <h3>Project Notes</h3>
                    <p>File · Opened a project document</p>
                  </div>
                </div>
              )}
            </div>

            {!timelineHasResults && (
              <p role="status">No activities found. Try a different search.</p>
            )}
          </section>
        )}

        <EmptyState
          title="Your timeline will start here"
          description="No activity has been collected. Application, website, file-change, idle, and lock events are planned; there is no persistent history yet."
        />

        {page === "Search" && (
          <section className="panel">
            <p className="eyebrow">SEARCH ACTIVITY</p>
            <h2>Search your recorded evidence</h2>

            <p>
              Search for applications, websites, and files from your work
              sessions. Keyword search requires SQLite FTS5. Optional Gemini
              evidence search comes later, after explicit opt-in.
            </p>

            <div className="notice">
              <strong>Preview only</strong>
              <span>
                Search results below are examples. Real activity history is not
                connected yet.
              </span>
            </div>

            <div className="search-row">
              <input
                type="search"
                placeholder="Search your activity..."
                aria-label="Search activity"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button
                type="button"
                onClick={() =>
                  document
                    .querySelector<HTMLInputElement>(
                      'input[aria-label="Search activity"]',
                    )
                    ?.focus()
                }
              >
                Search
              </button>
              id="search" placeholder="Search is not available yet" disabled /
              <button disabled>Search</button>
            </div>

            <div className="timeline-list">
              {["visual studio code", "application", "react project"].some(
                (text) => text.includes(searchQuery.toLowerCase().trim()),
              ) && (
                <div className="timeline-card">
                  <span className="timeline-time">10:30 AM</span>
                  <div>
                    <h3>Visual Studio Code</h3>
                    <p>Application · Working on a React project</p>
                  </div>
                </div>
              )}

              {["chrome", "website", "react documentation"].some((text) =>
                text.includes(searchQuery.toLowerCase().trim()),
              ) && (
                <div className="timeline-card">
                  <span className="timeline-time">10:15 AM</span>
                  <div>
                    <h3>Chrome</h3>
                    <p>Website · Reading React documentation</p>
                  </div>
                </div>
              )}

              {["project notes", "file", "project document"].some((text) =>
                text.includes(searchQuery.toLowerCase().trim()),
              ) && (
                <div className="timeline-card">
                  <span className="timeline-time">09:45 AM</span>
                  <div>
                    <h3>Project Notes</h3>
                    <p>File · Opened a project document</p>
                  </div>
                </div>
              )}
            </div>
            {!searchHasResults && (
              <p role="status">No results found. Try a different search.</p>
            )}
          </section>
        )}

        {page === "Checkpoints" && (
          <section className="panel">
            <p className="eyebrow">FILE CHECKPOINTS</p>
            <h2>Your saved checkpoints</h2>

            <p>View saved versions of your files and restore previous work.</p>

            <div className="notice">
              <strong>Preview only</strong>
              <span>
                These checkpoints are examples for the interface design. File
                backup and recovery are not connected yet.
              </span>
            </div>

            <div className="timeline-list">
              <div className="timeline-card">
                <span className="timeline-time">Today · 10:30 AM</span>
                <div>
                  <h3>React Project</h3>
                  <p>3 files · Example checkpoint</p>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedCheckpoint(
                        selectedCheckpoint === "react" ? null : "react",
                      )
                    }
                  >
                    {selectedCheckpoint === "react"
                      ? "Hide details"
                      : "View details"}
                  </button>

                  {selectedCheckpoint === "react" && (
                    <div>
                      <p>Example saved files:</p>
                      <p>App.tsx · styles.css · package.json</p>

                      <button
                        type="button"
                        onClick={() =>
                          setPreviewFile(
                            previewFile === "App.tsx" ? null : "App.tsx",
                          )
                        }
                      >
                        {previewFile === "App.tsx"
                          ? "Close preview"
                          : "Preview App.tsx"}
                      </button>

                      {previewFile === "App.tsx" && (
                        <div className="timeline-card checkpoint-preview">
                          <div>
                            <h3>App.tsx — Version preview</h3>
                            <p>Example version: Today at 10:30 AM</p>
                            <p>Status: Saved version preview (demo)</p>
                            <p>Restore is not available yet.</p>
                          </div>
                        </div>
                      )}
                      <p>Preview only — file recovery is not available yet.</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="timeline-card">
                <span className="timeline-time">Yesterday · 04:15 PM</span>
                <div>
                  <h3>Project Documents</h3>
                  <p>2 files · Example checkpoint</p>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedCheckpoint(
                        selectedCheckpoint === "documents" ? null : "documents",
                      )
                    }
                  >
                    {selectedCheckpoint === "documents"
                      ? "Hide details"
                      : "View details"}
                  </button>

                  {selectedCheckpoint === "documents" && (
                    <div>
                      <p>Example saved files:</p>
                      <p>ProjectReport.docx · Notes.pdf</p>
                      <p>Preview only — file recovery is not available yet.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {page === "Checkpoints" && (
          <EmptyState
            title="No checkpoints yet"
            description="Future checkpoints will group captured file versions, websites, and project references. They cannot restore arbitrary unsaved application state."
          />
        )}
        {page === "Settings" && (
          <section className="panel">
            <h2>Privacy comes first</h2>
            <div className="notice">
              <strong>Privacy settings</strong>
              <span>
                Activity collection is currently disabled. These settings are
                for interface preview only.
              </span>
            </div>

            <p>
              These are planned defaults, shown for reference. Settings editing
              and persistence are not available yet.
            </p>

            <dl className="settings-list">
              <div>
                <dt>Activity collection</dt>
                <dd>Off · unavailable</dd>
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
                <dt>Stored history / snapshots</dt>
                <dd>Not implemented</dd>
              </div>
            </dl>

            <p className="footnote">
              No keystrokes, clipboard contents, screenshots, or private browser
              activity will be captured. Encryption is a release requirement.
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
