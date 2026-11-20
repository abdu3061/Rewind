import { useEffect, useState } from "react";
import type {
  ActivityEvent,
  CapturedVersionSummary,
  CheckpointSummary,
  RuntimeSnapshot,
} from "@rewind/contracts";
import {
  BookmarkSimpleIcon,
  ClockCounterClockwiseIcon,
  FolderSimpleIcon,
} from "@phosphor-icons/react";
import { formatBytes, plural, relativeTime } from "./ui";

type Navigate = (page: "Timeline" | "Files" | "Checkpoints") => void;

export function activitySummary(event: ActivityEvent): {
  title: string;
  detail: string;
} {
  switch (event.type) {
    case "foreground":
      return {
        title: event.payload.windowTitle || "Untitled window",
        detail: event.payload.application,
      };
    case "file-change":
      return {
        title: event.payload.displayName ?? "Protected file",
        detail: event.payload.change === "captured" ? "Backup saved" : "Saved",
      };
    case "browser-visit":
      return {
        title: event.payload.title || "Untitled page",
        detail: event.payload.browser === "edge" ? "Edge" : "Chrome",
      };
    case "capture-gap":
      return { title: "Recording gap", detail: event.payload.reason };
    default:
      return { title: "Activity", detail: "" };
  }
}

/** Home overview: the latest activity, saved files and checkpoints. */
export function RecentOverview({
  runtime,
  onNavigate,
  onOpenVersion,
}: {
  runtime: RuntimeSnapshot | null;
  onNavigate: Navigate;
  onOpenVersion(id: string): void;
}) {
  const readable = Boolean(runtime?.secureStorage && window.rewind?.timeline);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [versions, setVersions] = useState<CapturedVersionSummary[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [refresh, setRefresh] = useState(0);
  const authority = `${runtime?.documentAuthority.generation ?? ""}:${runtime?.documentAuthority.revision ?? ""}`;
  const sessionKey = `${runtime?.session?.id ?? ""}:${runtime?.session?.status ?? ""}`;
  useEffect(() => {
    if (!readable) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.rewind.timeline.onChanged(() => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          setRefresh((value) => value + 1);
        }, 400);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [readable]);
  useEffect(() => {
    if (!readable) {
      setEvents([]);
      setVersions([]);
      setCheckpoints([]);
      return;
    }
    let mounted = true;
    void Promise.all([
      window.rewind.timeline.query({ limit: 6 }),
      window.rewind.versions.list({ limit: 5 }),
      window.rewind.checkpoints.list({ limit: 3 }),
    ])
      .then(([activity, files, saved]) => {
        if (!mounted) return;
        if (activity.ok) setEvents(activity.value);
        if (files.ok) setVersions(files.value);
        if (saved.ok) setCheckpoints(saved.value);
      })
      .catch(() => {
        // The overview is a convenience; each full page reports its own errors.
      });
    return () => {
      mounted = false;
    };
  }, [readable, refresh, authority, sessionKey]);
  if (!readable) return null;
  return (
    <div className="overview-grid">
      <section className="panel overview" aria-labelledby="recent-activity">
        <header>
          <ClockCounterClockwiseIcon size={20} aria-hidden="true" />
          <h2 id="recent-activity">Recent activity</h2>
          <button
            className="ghost"
            aria-label="View all activity"
            onClick={() => onNavigate("Timeline")}
          >
            View all
          </button>
        </header>
        {events.length ? (
          <ul className="compact-list">
            {events.map((event) => {
              const summary = activitySummary(event);
              return (
                <li key={event.id}>
                  <span className="row-main">
                    <strong>{summary.title}</strong>
                    <small>{summary.detail}</small>
                  </span>
                  <time dateTime={event.occurredAt}>
                    {relativeTime(event.occurredAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="hint">Nothing recorded yet.</p>
        )}
      </section>
      <section className="panel overview" aria-labelledby="recent-files">
        <header>
          <FolderSimpleIcon size={20} aria-hidden="true" />
          <h2 id="recent-files">Recent files</h2>
          <button
            className="ghost"
            aria-label="View all files"
            onClick={() => onNavigate("Files")}
          >
            View all
          </button>
        </header>
        {versions.length ? (
          <ul className="compact-list">
            {versions.map((item) => (
              <li key={item.version.id}>
                <button
                  className="row-button"
                  aria-label={`Open saved version of ${item.displayName}`}
                  onClick={() => onOpenVersion(item.version.id)}
                >
                  <span className="row-main">
                    <strong>{item.displayName}</strong>
                    <small>{formatBytes(item.version.byteLength)}</small>
                  </span>
                  <time dateTime={item.version.capturedAt}>
                    {relativeTime(item.version.capturedAt)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">
            No saved versions yet. Protected files appear here when they change.
          </p>
        )}
      </section>
      <section className="panel overview" aria-labelledby="recent-checkpoints">
        <header>
          <BookmarkSimpleIcon size={20} aria-hidden="true" />
          <h2 id="recent-checkpoints">Checkpoints</h2>
          <button
            className="ghost"
            aria-label="View all checkpoints"
            onClick={() => onNavigate("Checkpoints")}
          >
            View all
          </button>
        </header>
        {checkpoints.length ? (
          <ul className="compact-list">
            {checkpoints.map((checkpoint) => (
              <li key={checkpoint.id}>
                <span className="row-main">
                  <strong>{checkpoint.name}</strong>
                  <small>
                    {plural(checkpoint.fileVersionCount, "file")} ·{" "}
                    {plural(checkpoint.activityCount, "activity", "activities")}
                    {checkpoint.kept ? " · Kept" : ""}
                  </small>
                </span>
                <time dateTime={checkpoint.createdAt}>
                  {relativeTime(checkpoint.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">
            Save a checkpoint to bookmark a moment you may want to return to.
          </p>
        )}
      </section>
    </div>
  );
}
