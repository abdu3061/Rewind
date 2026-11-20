// The overlay is a second, less-privileged view of the same worker. No grants,
// maintenance, native dialogs, recovery, content parsing or cloud tools here.
export function notchAllowsRecording(command: unknown): boolean {
  if (!command || typeof command !== "object" || !("kind" in command))
    return false;
  return [
    "runtime.get",
    "timeline.query",
    "versions.list",
    "checkpoints.create",
  ].includes(String(command.kind));
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}
// Electron screen and window bounds are already device-independent pixels.
export function notchBounds(
  area: WorkArea,
  expanded: boolean,
  expandedHeight = 270,
): WorkArea {
  const width = Math.max(1, Math.min(expanded ? 760 : 144, area.width));
  const height = Math.max(
    1,
    Math.min(expanded ? expandedHeight : 64, area.height),
  );
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y),
    width: Math.round(width),
    height: Math.round(height),
  };
}
