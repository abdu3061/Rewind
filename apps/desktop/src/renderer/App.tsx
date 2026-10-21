import { useEffect, useState } from 'react';
import type { SessionAction, SessionState } from '@rewind/contracts';

const pages = ['Dashboard', 'Timeline', 'Search', 'Checkpoints', 'Settings'] as const;
type Page = (typeof pages)[number];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function App() {
  const [page, setPage] = useState<Page>('Dashboard');
  const [state, setState] = useState<SessionState>({ session: null });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.rewind.sessions.onChanged((next) => {
      if (mounted) setState(next);
    });
    void window.rewind.sessions.get().then((result) => {
      if (!mounted) return;
      if (result.ok) setState(result.value);
      else setError(result.error.message);
      setReady(result.ok);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function run(action: Exclude<SessionAction, 'get'>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.rewind.sessions[action]();
      if (result.ok) setState(result.value);
      else setError(result.error.message);
    } catch {
      setError('Could not reach the desktop session service.');
    } finally {
      setBusy(false);
    }
  }

  const session = state.session;
  const status = session?.status ?? 'not started';
  const canStart = !session || session.status === 'ended';

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
              className={page === item ? 'nav-item selected' : 'nav-item'}
              aria-current={page === item ? 'page' : undefined}
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
            Session controls work in memory. Activity collection, file protection, and history
            storage are not connected.
          </span>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {page === 'Dashboard' && (
          <>
            <section className="panel session-panel" aria-labelledby="session-heading">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">SESSION CONTROLS</p>
                  <h2 id="session-heading">A place to pick up where you left off.</h2>
                </div>
                <span
                  className={`status status-${session?.status ?? 'none'}`}
                  data-testid="session-status"
                  role="status"
                >
                  {ready ? status : 'loading'}
                </span>
              </div>
              <p>
                Start a session to try the lifecycle. Starting does not enable monitoring or protect
                files in this build.
              </p>
              <div className="controls" aria-label="Session controls">
                <button
                  className="primary"
                  onClick={() => void run('start')}
                  disabled={!ready || busy || !canStart}
                >
                  Start session
                </button>
                <button
                  onClick={() => void run('pause')}
                  disabled={!ready || busy || status !== 'active'}
                >
                  Pause
                </button>
                <button
                  onClick={() => void run('resume')}
                  disabled={!ready || busy || status !== 'paused'}
                >
                  Resume
                </button>
                <button
                  className="end-button"
                  onClick={() => void run('end')}
                  disabled={!ready || busy || canStart}
                >
                  End session
                </button>
              </div>
              <div className="session-meta">
                {session ? (
                  <>
                    Started {formatTime(session.startedAt)}
                    {session.endedAt && <> · Ended {formatTime(session.endedAt)}</>}
                  </>
                ) : (
                  'No session started in this app process.'
                )}
              </div>
            </section>
            <div className="card-grid">
              <section className="panel">
                <p className="eyebrow">ACTIVITY HISTORY</p>
                <h2>Nothing captured</h2>
                <p>
                  Timeline events will appear here once collectors and encrypted storage are ready.
                </p>
                <button className="text-button" onClick={() => setPage('Timeline')}>
                  View timeline <span aria-hidden="true">→</span>
                </button>
              </section>
              <section className="panel">
                <p className="eyebrow">FILE PROTECTION</p>
                <h2>No folders protected</h2>
                <p>
                  Folder selection, saved versions, and reviewed recovery are planned for a later
                  milestone.
                </p>
                <span className="subtle-label">Not available in this build</span>
              </section>
            </div>
            <p className="footnote">
              Sessions reset when Rewind exits. Closing the window quits this starter.
            </p>
          </>
        )}

        {page === 'Timeline' && (
          <EmptyState
            title="Your timeline will start here"
            description="No activity has been collected. Application, website, file-change, idle, and lock events are planned; there is no persistent history yet."
          />
        )}
        {page === 'Search' && (
          <section className="panel">
            <h2>Search your recorded evidence</h2>
            <p>
              Keyword search requires SQLite FTS5. Optional Gemini evidence search comes later,
              after explicit opt-in.
            </p>
            <label htmlFor="search">Search activity</label>
            <div className="search-row">
              <input id="search" placeholder="Search is not available yet" disabled />
              <button disabled>Search</button>
            </div>
            <p className="footnote">No data is sent to an AI provider.</p>
          </section>
        )}
        {page === 'Checkpoints' && (
          <EmptyState
            title="No checkpoints yet"
            description="Future checkpoints will group captured file versions, websites, and project references. They cannot restore arbitrary unsaved application state."
          />
        )}
        {page === 'Settings' && (
          <section className="panel">
            <h2>Privacy comes first</h2>
            <p>
              These are planned defaults, shown for reference. Settings editing and persistence are
              not available yet.
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
                <dd>72 hours planned</dd>
              </div>
              <div>
                <dt>Storage limit</dt>
                <dd>2 GiB proposed default</dd>
              </div>
              <div>
                <dt>Stored history / snapshots</dt>
                <dd>Not implemented</dd>
              </div>
            </dl>
            <p className="footnote">
              No keystrokes, clipboard contents, screenshots, or private browser activity will be
              captured. Encryption is a release requirement.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
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
