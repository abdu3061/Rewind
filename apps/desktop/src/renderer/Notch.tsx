import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRightIcon,
  ArrowUpIcon,
  BookmarkSimpleIcon,
  ClockCounterClockwiseIcon,
  XIcon,
  MinusIcon,
  PlayIcon,
  PauseIcon,
  StopIcon,
  FolderSimpleIcon,
} from "@phosphor-icons/react";
import type {
  ActivityEvent,
  CapturedVersionSummary,
  SessionAction,
} from "@rewind/contracts";
import { useRecordingRuntime } from "./recording";
import { usePresentation } from "./presentation";
import { parseNotchCommand, notchEvidenceStamp } from "./notch-command";
import { Mascot } from "./Mascot";
import "./notch.css";

function activityLabel(event: ActivityEvent): string {
  switch (event.type) {
    case "foreground":
      return `${event.payload.application} · ${event.payload.windowTitle}`;
    case "browser-visit":
      return `${event.payload.title || "Web page"} · ${event.payload.url}`;
    case "file-change":
      return `${event.payload.displayName ?? "Saved file"} · ${event.payload.change}`;
    case "capture-gap":
      return `Capture gap · ${event.payload.reason}`;
    case "file-opened":
      return event.payload.displayName;
    case "idle":
    case "lock":
      return `${event.type} · ${event.payload.state}`;
  }
}

export function Notch() {
  const { runtime, runtimeError } = useRecordingRuntime();
  const presentation = usePresentation();
  const expanded = presentation?.expanded ?? false;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [newActivity, setNewActivity] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [storedResults, setResults] = useState<{
    events: ActivityEvent[];
    stamp: string;
  } | null>(null);
  const [storedReview, setReview] = useState<{
    stamp: string;
    sessionId: string;
    files: CapturedVersionSummary[];
    activities: ActivityEvent[];
  } | null>(null);
  const evidenceStamp = notchEvidenceStamp(runtime);
  const evidenceVisible =
    expanded &&
    presentation?.notchVisible &&
    runtime?.secureStorage &&
    runtime.service === "ready";
  // Fence during render, before passive effects can clear old retained content.
  const results =
    evidenceVisible && storedResults?.stamp === evidenceStamp
      ? storedResults.events
      : null;
  const review =
    evidenceVisible && storedReview?.stamp === evidenceStamp
      ? storedReview
      : null;
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const serial = useRef(0);
  const pending = useRef(false);
  const context = useRef({ visible: false, expanded: false, sessionId: "" });
  context.current = {
    visible: presentation?.notchVisible ?? false,
    expanded,
    sessionId: runtime?.session?.id ?? "",
  };
  const input = useRef<HTMLInputElement>(null);
  const compact = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const pointerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const state = runtime?.session?.status ?? "not started";
  const available = runtime?.service === "ready";
  const recording = runtime?.collection === "active";
  const unavailable =
    runtime?.service === "unavailable" || runtime?.collection === "unavailable";
  const issue = runtimeError || runtime?.error?.message || error;
  const status = unavailable
    ? "Recording unavailable"
    : recording
      ? "Recording"
      : state === "paused"
        ? "Session paused"
        : state === "active"
          ? "Session active · Recording off"
          : "Recording off";

  useEffect(() => {
    document.documentElement.classList.add("notch-document");
    return () => {
      document.documentElement.classList.remove("notch-document");
      clearTimeout(pointerTimer.current);
      // A monotonic request counter, not a DOM ref: invalidate every pending reply.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      serial.current++;
    };
  }, []);
  useEffect(() => {
    // No retained evidence stays visible after hide, maintenance or authority change.
    serial.current++;
    setResults(null);
    setReview(null);
    setError("");
  }, [
    presentation?.notchVisible,
    expanded,
    runtime?.session?.id,
    runtime?.documentAuthority.generation,
    runtime?.documentAuthority.revision,
    runtime?.assistant.generation,
    runtime?.assistant.revision,
    runtime?.service,
  ]);
  useEffect(
    () =>
      window.rewind?.timeline?.onChanged(() => {
        // Keep an explicit query/selection stable while new observations arrive.
        // Removals are fenced by source authority and rechecked by the engine.
        setNewActivity(true);
      }),
    [],
  );
  useEffect(() => {
    setMessage("");
  }, [presentation?.notchVisible, expanded, runtime?.session?.id]);
  useEffect(() => {
    if (!expanded && document.hasFocus())
      compact.current?.focus({ preventScroll: true });
  }, [expanded]);
  useEffect(() => {
    if (!expanded || !panel.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      void window.rewind.presentation.send({
        action: "resize",
        height: Math.max(
          200,
          Math.min(
            560,
            Math.ceil(
              (entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height) +
                16,
            ),
          ),
        ),
      });
    });
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [expanded]);

  function windowAction(action: "expand" | "collapse" | "hide" | "open") {
    void window.rewind.presentation.send({ action });
  }
  async function perform(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    setResults(null);
    try {
      await operation();
    } catch {
      setError(
        "Rewind could not finish this action. Try again or open the full app.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function sessionAction(action: Exclude<SessionAction, "get">) {
    await perform(async () => {
      const result = await window.rewind.sessions[action]();
      if (!result.ok) setError(result.error.message);
      // Status comes from the same revisioned runtime stream as the desktop.
    });
  }
  async function search(text?: string, browser?: true) {
    await perform(async () => {
      setReview(null);
      const ticket = ++serial.current;
      const result = await window.rewind.timeline.query({
        limit: 5,
        ...(text ? { text } : {}),
        ...(browser ? { types: ["browser-visit"] } : {}),
      });
      if (ticket !== serial.current) return;
      if (result.ok) {
        setNewActivity(false);
        setResults({ events: result.value, stamp: evidenceStamp });
        setMessage(
          text
            ? `Local matches for “${text}”`
            : browser
              ? "Recent recorded websites"
              : "Your recent recorded activity",
        );
      } else setError(result.error.message);
    });
  }
  async function prepareCheckpoint() {
    const sessionId = runtime?.session?.id;
    if (!sessionId || state === "ended") {
      setError(
        "Start a session to save a checkpoint, or open Checkpoints for past sessions.",
      );
      return;
    }
    await perform(async () => {
      const ticket = ++serial.current;
      const [files, activities] = await Promise.all([
        window.rewind.versions.list({ sessionId, limit: 10 }),
        window.rewind.timeline.query({ sessionId, limit: 10 }),
      ]);
      if (ticket !== serial.current) return;
      if (!files.ok) {
        setError(files.error.message);
        return;
      }
      if (!activities.ok) {
        setError(activities.error.message);
        return;
      }
      if (!files.value.length && !activities.value.length) {
        setMessage(
          "Nothing captured in this session yet. Check recording permissions in Rewind.",
        );
        return;
      }
      setReview({
        stamp: evidenceStamp,
        sessionId,
        files: files.value,
        activities: activities.value,
      });
      setSelected([]);
      setName("");
    });
  }
  async function saveCheckpoint() {
    if (!review || !selected.length || !name.trim()) return;
    await perform(async () => {
      const result = await window.rewind.checkpoints.create({
        sessionId: review.sessionId,
        name: name.trim(),
        kept: false,
        fileVersionIds: review.files
          .filter((item) => selected.includes(item.version.id))
          .map((item) => item.version.id),
        activityIds: review.activities
          .filter((item) => selected.includes(item.id))
          .map((item) => item.id),
      });
      // Saving a checkpoint itself advances retained-evidence authority. Its
      // acknowledged write result may still be shown in the same visible session.
      if (
        !context.current.visible ||
        !context.current.expanded ||
        context.current.sessionId !== review.sessionId
      )
        return;
      if (result.ok) {
        setReview(null);
        setMessage(
          `Checkpoint “${result.value.name}” saved. Manage Keep in Rewind.`,
        );
      } else setError(result.error.message);
    });
  }
  async function submit() {
    if (!draft.trim() || busy) return;
    const intent = parseNotchCommand(draft);
    switch (intent.kind) {
      case "session":
        await sessionAction(intent.action);
        break;
      case "checkpoint":
        await prepareCheckpoint();
        break;
      case "open":
        await window.rewind.presentation.send({
          action: "open",
          ...(intent.page ? { page: intent.page } : {}),
        });
        break;
      case "search":
        await search(intent.text, intent.browser);
        break;
    }
  }
  if (!window.rewind?.presentation || !window.rewind?.runtime) {
    return (
      <div className="notch-root">
        <section className="notch-panel" role="alert">
          <strong>Rewind connection unavailable</strong>
          <p>
            Open Rewind from the tray. Session controls are unavailable here.
          </p>
        </section>
      </div>
    );
  }
  return (
    <div
      className={`notch-root ${expanded ? "is-expanded" : "is-compact"}`}
      onPointerEnter={() => {
        clearTimeout(pointerTimer.current);
        if (!expanded)
          pointerTimer.current = setTimeout(() => windowAction("expand"), 180);
      }}
      onPointerLeave={() => {
        clearTimeout(pointerTimer.current);
        if (!document.hasFocus())
          pointerTimer.current = setTimeout(
            () => windowAction("collapse"),
            250,
          );
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          windowAction("collapse");
        }
      }}
    >
      {!expanded ? (
        <button
          ref={compact}
          className="notch-compact"
          aria-label={`Expand Rewind · ${status}`}
          aria-expanded={false}
          onClick={() => {
            windowAction("expand");
            setTimeout(() => input.current?.focus(), 80);
          }}
        >
          <Mascot state={recording ? "recording" : "idle"} />
          <span
            className={`recording-light ${recording ? "is-recording" : ""}`}
            aria-hidden="true"
          />
          <span className="compact-wordmark">rewind</span>
        </button>
      ) : (
        <section
          ref={panel}
          className="notch-panel"
          aria-label="Rewind quick controls"
        >
          <header className="notch-header">
            <span className="notch-wordmark">
              Rewind <span>Your work, within reach</span>
            </span>
            <div className="notch-window-actions">
              <button onClick={() => windowAction("open")}>
                <ArrowUpRightIcon aria-hidden="true" size={15} /> Open Rewind
              </button>
              <button
                aria-label="Collapse notch"
                title="Collapse (Escape)"
                onClick={() => windowAction("collapse")}
              >
                <MinusIcon aria-hidden="true" size={17} />
              </button>
              <button
                aria-label="Hide notch"
                title="Hide notch · reopen from the tray"
                onClick={() => windowAction("hide")}
              >
                <XIcon aria-hidden="true" size={17} />
              </button>
            </div>
          </header>
          <div className="notch-command-row">
            <Mascot
              state={
                busy
                  ? "thinking"
                  : message.startsWith("Checkpoint")
                    ? "success"
                    : recording
                      ? "recording"
                      : "idle"
              }
            />
            <form
              className="notch-command"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="sr-only" htmlFor="notch-command">
                Ask Rewind
              </label>
              <input
                ref={input}
                id="notch-command"
                placeholder="Find a moment. Pick up where you left off."
                maxLength={500}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoComplete="off"
              />
              <button
                className="notch-send"
                type="submit"
                aria-label="Run command"
                disabled={!available || busy || !draft.trim()}
              >
                <ArrowUpIcon aria-hidden="true" size={20} />
              </button>
            </form>
          </div>
          <div className="notch-actions">
            <button
              disabled={!available || busy}
              onClick={() =>
                void sessionAction(
                  state === "active"
                    ? "pause"
                    : state === "paused"
                      ? "resume"
                      : "start",
                )
              }
            >
              {state === "active" ? (
                <PauseIcon size={17} aria-hidden="true" />
              ) : (
                <PlayIcon size={17} aria-hidden="true" />
              )}
              {state === "active"
                ? "Pause session"
                : state === "paused"
                  ? "Resume session"
                  : "Start session"}
            </button>
            <button
              disabled={!available || busy}
              onClick={() => void prepareCheckpoint()}
            >
              <BookmarkSimpleIcon size={17} aria-hidden="true" /> Save
              checkpoint
            </button>
            <button disabled={!available || busy} onClick={() => void search()}>
              <ClockCounterClockwiseIcon size={17} aria-hidden="true" /> What
              was I working on?
            </button>
            <button
              aria-label="Restore a file in Rewind"
              onClick={() =>
                void window.rewind.presentation.send({
                  action: "open",
                  page: "Files",
                })
              }
            >
              <FolderSimpleIcon size={18} aria-hidden="true" />
              Restore file
            </button>
          </div>
          <div className="notch-status-row">
            <span role="status" data-testid="notch-recording-status">
              <span
                className={`recording-light ${recording ? "is-recording" : ""}`}
              />
              {status}
            </span>
            <span>Local search · AI reviews in full app</span>
            {(state === "active" || state === "paused") && (
              <button disabled={busy} onClick={() => void sessionAction("end")}>
                <StopIcon size={12} aria-hidden="true" /> End session
              </button>
            )}
          </div>
          <div className="notch-response" aria-busy={busy}>
            {issue && (
              <p className="notch-error" role="alert">
                {issue}
              </p>
            )}
            {unavailable && (
              <button
                className="notch-link"
                onClick={() =>
                  void window.rewind.presentation.send({
                    action: "open",
                    page: "Dashboard",
                  })
                }
              >
                Reconnect in Rewind{" "}
                <ArrowUpRightIcon size={13} aria-hidden="true" />
              </button>
            )}
            {busy && <p role="status">Working on it…</p>}
            {message && <p role="status">{message}</p>}
            {results && (
              <>
                {newActivity && (
                  <p className="notch-refresh-note">
                    New activity recorded. Search again to refresh.
                  </p>
                )}
                {results.length ? (
                  <ul className="notch-results">
                    {results.map((event) => (
                      <li key={event.id}>
                        <span>{activityLabel(event)}</span>
                        <time dateTime={event.occurredAt}>
                          {new Date(event.occurredAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    No matching recorded activity. Search saved file contents in
                    the full app.
                  </p>
                )}
                <button
                  className="notch-link"
                  onClick={() =>
                    void window.rewind.presentation.send({
                      action: "open",
                      page: "Search",
                    })
                  }
                >
                  Open full Search{" "}
                  <ArrowUpRightIcon size={13} aria-hidden="true" />
                </button>
              </>
            )}
            {review && (
              <form
                className="notch-checkpoint"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveCheckpoint();
                }}
              >
                <label>
                  Checkpoint name
                  <input
                    value={name}
                    maxLength={120}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </label>
                <fieldset>
                  <legend>Select recent evidence from this session</legend>
                  {[
                    ...review.files.map((item) => ({
                      id: item.version.id,
                      label: item.displayName,
                    })),
                    ...review.activities.map((item) => ({
                      id: item.id,
                      label: activityLabel(item),
                    })),
                  ].map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id),
                          )
                        }
                      />
                      {item.label}
                    </label>
                  ))}
                </fieldset>
                <div className="notch-save-row">
                  <small>
                    Up to 10 files + 10 observations. Ordinary retention
                    applies.
                  </small>
                  <button
                    type="submit"
                    disabled={busy || !selected.length || !name.trim()}
                  >
                    Save selected checkpoint
                  </button>
                </div>
              </form>
            )}
          </div>
          <footer className="notch-footer">
            You choose what Rewind records.{" "}
            <button
              onClick={() =>
                void window.rewind.presentation.send({
                  action: "open",
                  page: "Settings",
                })
              }
            >
              Manage permissions
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
