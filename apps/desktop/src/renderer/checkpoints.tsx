import { useEffect, useRef, useState } from "react";
import type {
  ActivityEvent,
  CapturedVersionSummary,
  CheckpointSummary,
  CheckpointView,
  RuntimeSnapshot,
  Session,
  VersionPreview,
  Result,
} from "@rewind/contracts";
import { RecoveryCopy } from "./recovery-copy";
import { RecoveryOverwrite } from "./recovery-overwrite";

const time = (value: string) => new Date(value).toLocaleString();
function label(event: ActivityEvent): string {
  switch (event.type) {
    case "foreground":
      return `${event.payload.application} · ${event.payload.windowTitle}`;
    case "file-change":
      return `${event.payload.displayName ?? "Saved file"} · ${event.payload.change}`;
    case "browser-visit":
      return `${event.payload.title} · ${event.payload.url}`;
    case "capture-gap":
      return `Capture gap · ${event.payload.collectorId} · ${event.payload.reason}`;
    case "file-opened":
      return event.payload.displayName;
    case "idle":
    case "lock":
      return `${event.type} · ${event.payload.state}`;
  }
}
export function Checkpoints({ runtime }: { runtime: RuntimeSnapshot | null }) {
  const [sessions, setSessions] = useState<Session[]>([]),
    [sessionId, setSessionId] = useState("");
  const [versions, setVersions] = useState<CapturedVersionSummary[]>([]),
    [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]),
    [selectedActivities, setSelectedActivities] = useState<string[]>([]);
  const [name, setName] = useState(""),
    [kept, setKept] = useState(true);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]),
    [view, setView] = useState<CheckpointView | null>(null);
  const [preview, setPreview] = useState<VersionPreview | null>(null),
    [editName, setEditName] = useState(""),
    [editKept, setEditKept] = useState(true);
  const [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [moreFiles, setMoreFiles] = useState(false),
    [moreSessions, setMoreSessions] = useState(false),
    [moreActivities, setMoreActivities] = useState(false),
    [moreCheckpoints, setMoreCheckpoints] = useState(false);
  const [evidenceRefresh, setEvidenceRefresh] = useState(0);
  const live = useRef(true),
    evidenceSerial = useRef(0),
    previewSerial = useRef(0);
  const readable = Boolean(
    runtime?.secureStorage && window.rewind?.checkpoints,
  );
  async function loadCheckpoints(older = false) {
    const last = older ? checkpoints.at(-1) : null;
    const result = await window.rewind.checkpoints.list({
      limit: 50,
      ...(last ? { before: { createdAt: last.createdAt, id: last.id } } : {}),
    });
    if (!live.current) return;
    if (result.ok) {
      setCheckpoints((current) =>
        last ? [...current, ...result.value].slice(-1000) : result.value,
      );
      setMoreCheckpoints(result.value.length === 50);
    } else setError(result.error.message);
  }
  useEffect(() => {
    live.current = true;
    evidenceSerial.current++;
    previewSerial.current++;
    let mounted = true;
    if (!readable) return;
    void Promise.all([
      window.rewind.history.list({ limit: 100 }),
      window.rewind.checkpoints.list({ limit: 50 }),
    ])
      .then(([history, saved]) => {
        if (!live.current || !mounted) return;
        if (history.ok) {
          setSessions(history.value);
          setMoreSessions(history.value.length === 100);
          setSessionId(history.value[0]?.id ?? "");
        } else setError(history.error.message);
        if (saved.ok) {
          setCheckpoints(saved.value);
          setMoreCheckpoints(saved.value.length === 50);
        } else setError(saved.error.message);
      })
      .catch(() => {
        if (live.current && mounted)
          setError("Checkpoint history could not be loaded.");
      });
    return () => {
      mounted = false;
      live.current = false;
    };
  }, [readable]);
  useEffect(() => {
    const ticket = ++evidenceSerial.current;
    setSelectedFiles([]);
    setSelectedActivities([]);
    setVersions([]);
    setActivities([]);
    if (!readable || !sessionId) return;
    void Promise.all([
      window.rewind.versions.list({ limit: 100, sessionId }),
      window.rewind.timeline.query({ limit: 100, sessionId }),
    ])
      .then(([files, events]) => {
        if (!live.current || ticket !== evidenceSerial.current) return;
        if (files.ok) {
          setVersions(files.value);
          setMoreFiles(files.value.length === 100);
        } else setError(files.error.message);
        if (events.ok) {
          setActivities(events.value);
          setMoreActivities(events.value.length === 100);
        } else setError(events.error.message);
      })
      .catch(() => {
        if (live.current && ticket === evidenceSerial.current)
          setError("Captured checkpoint evidence could not be loaded.");
      });
  }, [readable, sessionId, evidenceRefresh]);
  useEffect(() => {
    const id = view?.checkpoint.id;
    if (!readable || !id) return;
    let mounted = true,
      checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void window.rewind.checkpoints
        .list({ limit: 1, id })
        .then((result) => {
          if (!mounted) return;
          if (!result.ok || !result.value.length) {
            setView(null);
            setPreview(null);
            setMessage(
              "The checkpoint is no longer available from verified retained history.",
            );
          }
        })
        .catch(() => {
          if (mounted) {
            setView(null);
            setPreview(null);
          }
        })
        .finally(() => {
          checking = false;
        });
    }, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [readable, view?.checkpoint.id]);
  async function run(
    operation: () => Promise<Result<unknown>>,
    success?: string,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await operation();
      if (!live.current) return;
      if (!result.ok) setError(result.error.message);
      else if (success) {
        setMessage(success);
        await loadCheckpoints();
      }
    } catch {
      if (live.current)
        setError("The checkpoint operation could not be confirmed.");
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function inspect(id: string) {
    const result = await window.rewind.checkpoints.view(id);
    if (live.current && result.ok) {
      setView(result.value);
      setEditName(result.value.checkpoint.name);
      setEditKept(result.value.checkpoint.kept);
      setDeleting(false);
      setPreview(null);
      previewSerial.current++;
    }
    return result;
  }
  async function olderEvidence(files: boolean) {
    const ticket = evidenceSerial.current;
    if (files) {
      const last = versions.at(-1)?.version;
      if (!last) return { ok: true as const, value: true };
      const result = await window.rewind.versions.list({
        limit: 100,
        sessionId,
        before: { capturedAt: last.capturedAt, id: last.id },
      });
      if (live.current && ticket === evidenceSerial.current && result.ok) {
        setVersions((current) => [...current, ...result.value].slice(-1000));
        setMoreFiles(result.value.length === 100);
      }
      return result;
    }
    const last = activities.at(-1);
    if (!last) return { ok: true as const, value: true };
    const result = await window.rewind.timeline.query({
      limit: 100,
      sessionId,
      before: { occurredAt: last.occurredAt, id: last.id },
    });
    if (live.current && ticket === evidenceSerial.current && result.ok) {
      setActivities((current) => [...current, ...result.value].slice(-1000));
      setMoreActivities(result.value.length === 100);
    }
    return result;
  }
  if (!readable)
    return (
      <section className="panel">
        <h2>Checkpoints unavailable</h2>
        <p>Reconnect verified secure storage to manage saved evidence.</p>
      </section>
    );
  return (
    <>
      <section className="panel" aria-labelledby="checkpoint-create-heading">
        <h2 id="checkpoint-create-heading">Save a named checkpoint</h2>
        <p>
          Select actual retained versions and activity from one session. A
          checkpoint groups captured evidence; it cannot restore unsaved
          application state or prove a document was read.
        </p>
        <label htmlFor="checkpoint-session">Evidence session</label>
        <select
          id="checkpoint-session"
          value={sessionId}
          disabled={busy}
          onChange={(event) => setSessionId(event.target.value)}
        >
          {!sessions.length && <option value="">No recorded sessions</option>}
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {time(session.startedAt)} · {session.status} ·{" "}
              {session.id.slice(0, 8)}
            </option>
          ))}
        </select>
        {moreSessions && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const last = sessions.at(-1);
                if (!last) return { ok: true, value: true };
                const result = await window.rewind.history.list({
                  limit: 100,
                  before: { startedAt: last.startedAt, id: last.id },
                });
                if (live.current && result.ok) {
                  setSessions((current) => {
                    const selected = current.find(
                        (session) => session.id === sessionId,
                      ),
                      page = [...current, ...result.value].slice(-1000);
                    return selected &&
                      !page.some((session) => session.id === sessionId)
                      ? [selected, ...page]
                      : page;
                  });
                  setMoreSessions(result.value.length === 100);
                }
                return result;
              })
            }
          >
            Load older sessions
          </button>
        )}
        <button
          disabled={busy || !sessionId}
          onClick={() => setEvidenceRefresh((current) => current + 1)}
        >
          Refresh evidence and clear selection
        </button>
        <label htmlFor="checkpoint-name">Checkpoint name</label>
        <input
          id="checkpoint-name"
          maxLength={120}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={kept}
            disabled={busy}
            onChange={(event) => setKept(event.target.checked)}
          />{" "}
          Keep this checkpoint and its selected evidence
        </label>
        <p className="footnote">
          Kept evidence survives ordinary retention, quota cleanup and history
          deletion. Unkept checkpoints expire with retention and can be evicted
          for quota. Up to 100 file versions, 200 activities and 64 MiB of
          original bytes per checkpoint. Selection is checked again before
          saving.
        </p>
        <fieldset disabled={busy}>
          <legend>
            Captured file versions ({selectedFiles.length} selected)
          </legend>
          {!versions.length && <p>No captured versions in this session.</p>}
          <div className="evidence-picker">
            {versions.map((item) => (
              <label key={item.version.id}>
                <input
                  type="checkbox"
                  aria-label={`Select version ${item.displayName} ${item.version.capturedAt} from ${item.sourceLabel}`}
                  checked={selectedFiles.includes(item.version.id)}
                  disabled={
                    !selectedFiles.includes(item.version.id) &&
                    selectedFiles.length >= 100
                  }
                  onChange={(event) =>
                    setSelectedFiles((current) =>
                      event.target.checked
                        ? [...current, item.version.id]
                        : current.filter((id) => id !== item.version.id),
                    )
                  }
                />{" "}
                {item.displayName} · {time(item.version.capturedAt)} ·{" "}
                {item.version.byteLength.toLocaleString()} bytes
                <span className="content-hash"> · {item.sourceLabel}</span>
              </label>
            ))}
          </div>
          {moreFiles && (
            <button onClick={() => void run(() => olderEvidence(true))}>
              Load older file evidence
            </button>
          )}
        </fieldset>
        <fieldset disabled={busy}>
          <legend>
            Recorded activity ({selectedActivities.length} selected)
          </legend>
          {!activities.length && <p>No retained activity in this session.</p>}
          <div className="evidence-picker">
            {activities.map((event) => (
              <label key={event.id}>
                <input
                  type="checkbox"
                  aria-label={`Select activity ${event.id}`}
                  checked={selectedActivities.includes(event.id)}
                  disabled={
                    !selectedActivities.includes(event.id) &&
                    selectedActivities.length >= 200
                  }
                  onChange={(input) =>
                    setSelectedActivities((current) =>
                      input.target.checked
                        ? [...current, event.id]
                        : current.filter((id) => id !== event.id),
                    )
                  }
                />{" "}
                {time(event.occurredAt)} · {label(event)}
              </label>
            ))}
          </div>
          {moreActivities && (
            <button onClick={() => void run(() => olderEvidence(false))}>
              Load older activity evidence
            </button>
          )}
        </fieldset>
        <button
          className="primary"
          disabled={
            busy ||
            !name.trim() ||
            !sessionId ||
            selectedFiles.length + selectedActivities.length === 0
          }
          onClick={() =>
            void run(async () => {
              const result = await window.rewind.checkpoints.create({
                sessionId,
                name,
                kept,
                fileVersionIds: selectedFiles,
                activityIds: selectedActivities,
              });
              if (live.current && result.ok) {
                setName("");
                setSelectedFiles([]);
                setSelectedActivities([]);
                await inspect(result.value.id);
              }
              return result;
            }, "Checkpoint saved with confirmed captured evidence.")
          }
        >
          Save checkpoint
        </button>
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
      <section className="panel" aria-labelledby="saved-checkpoints-heading">
        <h2 id="saved-checkpoints-heading">Saved checkpoints</h2>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await loadCheckpoints();
              return { ok: true, value: true };
            })
          }
        >
          Refresh checkpoints
        </button>
        {!checkpoints.length && <p>No retained checkpoints.</p>}
        <ol className="timeline-events">
          {checkpoints.map((checkpoint) => (
            <li key={checkpoint.id} data-testid="saved-checkpoint">
              <strong>{checkpoint.name}</strong>
              <p>
                {time(checkpoint.createdAt)} ·{" "}
                {checkpoint.kept ? "Kept" : "Subject to retention"} ·{" "}
                {checkpoint.fileVersionCount} versions ·{" "}
                {checkpoint.activityCount} activities
              </p>
              <button
                disabled={busy}
                onClick={() => void run(() => inspect(checkpoint.id))}
                aria-label={`View checkpoint ${checkpoint.name}`}
              >
                View checkpoint
              </button>
            </li>
          ))}
        </ol>
        {moreCheckpoints && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await loadCheckpoints(true);
                return { ok: true, value: true };
              })
            }
          >
            Load older checkpoints
          </button>
        )}
      </section>
      {view && (
        <section className="panel" aria-labelledby="checkpoint-view-heading">
          <h2 id="checkpoint-view-heading">
            Checkpoint: {view.checkpoint.name}
          </h2>
          <p>
            Created {time(view.checkpoint.createdAt)} · session{" "}
            {view.checkpoint.sessionId}
          </p>
          <label htmlFor="checkpoint-edit-name">Saved checkpoint name</label>
          <input
            id="checkpoint-edit-name"
            maxLength={120}
            value={editName}
            disabled={busy}
            onChange={(event) => setEditName(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={editKept}
              disabled={busy}
              onChange={(event) => setEditKept(event.target.checked)}
            />{" "}
            Keep saved checkpoint
          </label>
          {!editKept && (
            <p>
              Saving without Keep releases its retention protection. Already
              expired evidence may disappear on the next cleanup.
            </p>
          )}
          <button
            disabled={busy || !editName.trim()}
            onClick={() =>
              void run(async () => {
                const result = await window.rewind.checkpoints.update({
                  id: view.checkpoint.id,
                  name: editName,
                  kept: editKept,
                });
                if (live.current && result.ok) {
                  setView(null);
                  setPreview(null);
                }
                return result;
              }, "Checkpoint updated. Unkept evidence follows retention and quota policy.")
            }
          >
            Save checkpoint changes
          </button>
          <h3>Captured file evidence</h3>
          <ol className="timeline-events">
            {view.versions.map((item) => (
              <li key={item.version.id}>
                <strong>{item.displayName}</strong>
                <p className="content-hash">{item.sourceLabel}</p>
                <p>
                  {time(item.version.capturedAt)} ·{" "}
                  {item.version.byteLength.toLocaleString()} bytes
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const ticket = ++previewSerial.current,
                        result = await window.rewind.versions.preview(
                          item.version.id,
                        );
                      if (
                        live.current &&
                        ticket === previewSerial.current &&
                        result.ok
                      )
                        setPreview(result.value);
                      return result;
                    })
                  }
                >
                  Preview checkpoint version
                </button>
              </li>
            ))}
          </ol>
          <h3>Recorded activity evidence</h3>
          <ul>
            {view.activities.map((event) => (
              <li key={event.id}>
                {time(event.occurredAt)} · {label(event)}
              </li>
            ))}
          </ul>
          {preview && (
            <div>
              <h3>Captured preview: {preview.displayName}</h3>
              {preview.text !== null ? (
                <pre className="captured-preview">{preview.text}</pre>
              ) : (
                <p>{preview.warning}</p>
              )}
              {preview.truncated && (
                <p>
                  Preview truncated. Recovery uses the complete original bytes.
                </p>
              )}
              <RecoveryCopy key={preview.version.id} preview={preview} />
              <RecoveryOverwrite
                key={`overwrite-${preview.version.id}`}
                preview={preview}
              />
            </div>
          )}
          {!deleting ? (
            <button
              className="end-button"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              Delete checkpoint
            </button>
          ) : (
            <div>
              <p>
                Delete this named checkpoint and release its evidence pins?
                Original files and recovered copies remain. Evidence follows
                retention after this manifest is removed.
              </p>
              <button
                className="end-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await window.rewind.checkpoints.delete(
                      view.checkpoint.id,
                      true,
                    );
                    if (live.current && result.ok) {
                      setView(null);
                      setPreview(null);
                    }
                    return result;
                  }, "Checkpoint deleted. Its evidence now follows ordinary retention.")
                }
              >
                Confirm delete checkpoint
              </button>
              <button disabled={busy} onClick={() => setDeleting(false)}>
                Cancel checkpoint deletion
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
