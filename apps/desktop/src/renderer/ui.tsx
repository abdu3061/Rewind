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

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
