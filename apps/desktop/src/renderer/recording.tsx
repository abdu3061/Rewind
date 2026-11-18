import { useEffect, useRef, useState } from "react";
import { AssistantSearch } from "./assistant";
import type {
  ActivityEvent,
  RuntimeSnapshot,
  Session,
  TimelineQuery,
} from "@rewind/contracts";

export function useRecordingRuntime() {
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(-1);
  useEffect(() => {
    const api = window.rewind?.runtime;
    if (!api) return;
    let mounted = true;
    function accept(next: RuntimeSnapshot) {
      if (!mounted || next.revision < seen.current) return;
      seen.current = next.revision;
      setRuntime(next);
      setError(null);
    }
    const unsubscribe = api.onChanged(accept);
    void api
      .get()
      .then((result) => {
        if (result.ok) accept(result.value);
        else if (mounted) setError(result.error.message);
      })
      .catch(() => {
        if (mounted) setError("Could not reach the secure recording service.");
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  return { runtime, runtimeError: error };
}

export function RecordingPreferences({
  runtime,
}: {
  runtime: RuntimeSnapshot | null;
}) {
  const exclusions = runtime?.preferences.excludedApplications.join("\n") ?? "";
  const [draft, setDraft] = useState(exclusions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(exclusions);
  }, [exclusions]);
  async function update(consent: boolean, revokeOnly = false) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.rewind.privacy.update({
        collectionConsent: consent,
        excludedApplications: revokeOnly
          ? (runtime?.preferences.excludedApplications ?? [])
          : draft
              .split(/\r?\n/)
              .map((item) => item.trim())
              .filter(Boolean),
      });
      if (!result.ok) setError(result.error.message);
      else setSaved(true);
    } catch {
      setError("Could not save recording preferences.");
    } finally {
      setBusy(false);
    }
  }
  const allowed = runtime?.preferences.collectionConsent ?? false;
  return (
    <section
      className="panel recording-preferences"
      aria-labelledby="recording-heading"
    >
      <h2 id="recording-heading">Windows activity permission</h2>
      <p>
        Allow Rewind to record application names, window titles and timestamps
        during an active session. Titles can contain sensitive information.
        Records stay in encrypted local storage on this Windows account.
      </p>
      <p>
        Approval expires when Rewind or its recording service restarts. Changing
        preferences pauses an active session; start or resume explicitly
        afterward. Browser windows, Rewind itself and excluded applications are
        skipped. File protection has its own selection and launch approval in
        Files. Browser metadata has separate controls below and extension
        approval.
      </p>
      <label htmlFor="application-exclusions">
        Excluded applications (one name per line)
      </label>
      <textarea
        id="application-exclusions"
        rows={3}
        maxLength={256000}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
        }}
        placeholder="Example: private-editor.exe"
      />
      <p className="footnote">
        Up to 200 names, matched without case or the .exe suffix. No keystrokes,
        clipboard capture or screenshots. Manage retention, storage and history
        deletion in Settings. Use nonsensitive development sessions while
        independent security review is pending.
      </p>
      <div className="controls">
        <button
          disabled={busy || runtime?.service !== "ready"}
          onClick={() => void update(allowed)}
        >
          Save exclusions
        </button>
        {!allowed && (
          <button
            className="primary"
            disabled={busy || runtime?.service !== "ready"}
            onClick={() => void update(true)}
          >
            Allow Windows activity for this launch
          </button>
        )}
        {allowed && (
          <button
            className="end-button"
            disabled={runtime?.service !== "ready" && !runtime?.secureStorage}
            onClick={() => void update(false, true)}
          >
            Revoke recording permission
          </button>
        )}
      </div>
      <p role="status">
        {busy
          ? "Saving preferences..."
          : saved
            ? "Preferences saved. Recording never resumes automatically."
            : allowed
              ? "Windows activity approved for this launch."
              : "Windows activity permission is off."}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function displayTime(value: string) {
  return new Date(value).toLocaleString();
}
function localTimestamp(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}
export function RecordedHistory({
  runtime,
  search = false,
}: {
  runtime: RuntimeSnapshot | null;
  search?: boolean;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  useEffect(() => {
    const visible = new Set(events.map((event) => event.id));
    setSelectedEvidence((ids) => {
      const retained = ids.filter((id) => visible.has(id));
      return retained.length === ids.length ? ids : retained;
    });
  }, [events]);
  const [query, setQuery] = useState<TimelineQuery>({ limit: 50 });
  const [text, setText] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [more, setMore] = useState(false);
  const [moreSessions, setMoreSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const canRead = Boolean(runtime?.secureStorage);
  const sessionKey = `${runtime?.session?.id ?? ""}:${runtime?.session?.status ?? ""}`;
  useEffect(() => {
    if (!canRead || !window.rewind?.timeline) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.rewind.timeline.onChanged(() => {
      // Coalesce committed-write notifications; they contain no document text.
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          setRefresh((value) => value + 1);
        }, 150);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [canRead]);
  useEffect(() => {
    let mounted = true;
    if (!canRead) {
      setSessions([]);
      return;
    }
    setLoadingSessions(true);
    void window.rewind.history
      .list({ limit: 100 })
      .then((result) => {
        if (!mounted) return;
        if (result.ok) {
          setSessions(result.value);
          setMoreSessions(result.value.length === 100);
        } else setError(result.error.message);
      })
      .catch(() => {
        if (mounted) setError("Could not read session history.");
      })
      .finally(() => {
        if (mounted) setLoadingSessions(false);
      });
    return () => {
      mounted = false;
    };
  }, [canRead, sessionKey]);
  useEffect(() => {
    const ticket = ++generation.current;
    setEvents([]);
    setMore(false);
    setError(null);
    if (!canRead) return;
    setLoading(true);
    void window.rewind.timeline
      .query(query)
      .then((result) => {
        if (ticket !== generation.current) return;
        if (result.ok) {
          setEvents(result.value);
          setMore(result.value.length === query.limit);
        } else setError(result.error.message);
      })
      .catch(() => {
        if (ticket === generation.current)
          setError("Could not read recorded activity.");
      })
      .finally(() => {
        if (ticket === generation.current) setLoading(false);
      });
    return () => {
      generation.current = ticket + 1;
    };
  }, [query, refresh, canRead, sessionKey]);
  async function loadOlderEvents() {
    const last = events.at(-1);
    if (!last || loading) return;
    const ticket = generation.current;
    setLoading(true);
    try {
      const result = await window.rewind.timeline.query({
        ...query,
        before: { occurredAt: last.occurredAt, id: last.id },
      });
      if (ticket !== generation.current) return;
      if (result.ok) {
        setEvents((current) => [...current, ...result.value]);
        setMore(result.value.length === query.limit);
      } else setError(result.error.message);
    } catch {
      if (ticket === generation.current)
        setError("Could not read older activity.");
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }
  async function loadOlderSessions() {
    const last = sessions.at(-1);
    if (!last || loadingSessions) return;
    setLoadingSessions(true);
    try {
      const result = await window.rewind.history.list({
        limit: 100,
        before: { startedAt: last.startedAt, id: last.id },
      });
      if (result.ok) {
        setSessions((current) => [...current, ...result.value]);
        setMoreSessions(result.value.length === 100);
      } else setError(result.error.message);
    } catch {
      setError("Could not read older sessions.");
    } finally {
      setLoadingSessions(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="history-heading">
      <h2 id="history-heading">
        {search ? "Search your recorded evidence" : "Recorded activity"}
      </h2>
      <p>
        Recorded application observations, saved-file events and capture gaps,
        newest first. A window title does not prove that a file was saved or
        read. Browser metadata needs both approvals. Idle and lock detection
        remain unavailable. Optional Gemini questions require separate cloud
        approval and per-question sharing review.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            setQuery({
              limit: 50,
              ...(sessionId ? { sessionId } : {}),
              ...(from ? { from: localTimestamp(from) } : {}),
              ...(to ? { to: localTimestamp(to) } : {}),
              ...(text.trim() ? { text: text.trim() } : {}),
              ...(type
                ? {
                    types: [
                      type as NonNullable<TimelineQuery["types"]>[number],
                    ],
                  }
                : {}),
            });
          } catch {
            setError("Enter a valid date range.");
          }
        }}
      >
        <div className="filter-grid">
          <label>
            Session
            <select
              aria-label="Session filter"
              disabled={!canRead}
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
            >
              <option value="">All sessions</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {displayTime(session.startedAt)} · {session.status} ·{" "}
                  {session.id.slice(-6)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Event type
            <select
              value={type}
              disabled={!canRead}
              onChange={(event) => setType(event.target.value)}
            >
              <option value="">All recorded types</option>
              <option value="foreground">Application activity</option>
              <option value="capture-gap">Capture gaps</option>
              <option value="file-change">Saved file changes</option>
              <option value="browser-visit">Browser visits</option>
            </select>
          </label>
          <label>
            From
            <input
              type="datetime-local"
              disabled={!canRead}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="datetime-local"
              disabled={!canRead}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
        <label htmlFor="history-search">Search history</label>
        <div className="search-row">
          <input
            id="history-search"
            maxLength={2000}
            disabled={!canRead}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search applications, window titles and captured file names"
          />
          <button type="submit" disabled={!canRead || loading}>
            {search ? "Search" : "Apply filters"}
          </button>
        </div>
      </form>
      {moreSessions && (
        <button
          disabled={loadingSessions}
          onClick={() => void loadOlderSessions()}
        >
          Load older sessions
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p role="status">
        {!canRead
          ? "Verified encrypted history is unavailable."
          : loading
            ? "Loading recorded history..."
            : `${events.length} recorded events shown.`}
      </p>
      {!loading && canRead && events.length === 0 && (
        <p>
          No recorded activity matches these filters. Approve Windows activity
          and start or resume a session to collect permitted observations.
        </p>
      )}
      {search && (
        <AssistantSearch
          runtime={runtime}
          selectedIds={selectedEvidence}
          clearSelection={() => setSelectedEvidence([])}
        />
      )}
      <ol className="timeline-events" aria-label="Recorded events">
        {events.map((event) => (
          <li key={event.id} data-testid="timeline-event">
            {search && (
              <label>
                <input
                  type="checkbox"
                  aria-label="Select observation for Gemini"
                  checked={selectedEvidence.includes(event.id)}
                  disabled={
                    !selectedEvidence.includes(event.id) &&
                    selectedEvidence.length >= 12
                  }
                  onChange={(input) =>
                    setSelectedEvidence((ids) =>
                      input.target.checked
                        ? [...ids, event.id]
                        : ids.filter((id) => id !== event.id),
                    )
                  }
                />{" "}
                Select for Gemini review
              </label>
            )}
            <time dateTime={event.occurredAt}>
              {displayTime(event.occurredAt)}
            </time>
            {event.type === "foreground" ? (
              <>
                <strong>{event.payload.application}</strong>
                <p>{event.payload.windowTitle || "Untitled window"}</p>
              </>
            ) : event.type === "file-change" ? (
              <>
                <strong>{event.payload.displayName ?? "Protected file"}</strong>
                <p>
                  Saved-file observation. Inspect captured versions in Files.
                  This does not prove that the file was read.
                </p>
              </>
            ) : event.type === "browser-visit" ? (
              <>
                <strong>{event.payload.title || "Untitled page"}</strong>
                <p>
                  {event.payload.browser === "edge"
                    ? "Microsoft Edge"
                    : "Google Chrome"}{" "}
                  · {event.payload.url}
                </p>
                <p>
                  Focused page observation. Page contents and time spent are not
                  captured.
                </p>
              </>
            ) : event.type === "capture-gap" ? (
              <>
                <strong>Capture gap</strong>
                <p>
                  {event.payload.collectorId}: {event.payload.reason}. Activity
                  during this gap was not recorded.
                </p>
              </>
            ) : (
              <strong>Unsupported event type</strong>
            )}
          </li>
        ))}
      </ol>
      {more && (
        <button disabled={loading} onClick={() => void loadOlderEvents()}>
          Load older activity
        </button>
      )}
    </section>
  );
}
