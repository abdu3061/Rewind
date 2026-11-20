import type { ReactNode } from "react";
import { Mascot } from "./Mascot";

/** Collapsed details for limits and caveats, so panels lead with their controls. */
export function HowItWorks({
  children,
  summary = "How this works",
}: {
  children: ReactNode;
  summary?: string;
}) {
  return (
    <details className="how-it-works">
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Mascot className="empty-mascot" />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "2 minutes ago" for recent times, otherwise a short date and time. */
export function relativeTime(value: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(value) - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
