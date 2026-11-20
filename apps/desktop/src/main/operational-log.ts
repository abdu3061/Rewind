import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

export type OperationalCode =
  | "DESKTOP_STARTING"
  | "DESKTOP_READY"
  | "DESKTOP_START_FAILED"
  | "SERVICE_UNAVAILABLE"
  | "RENDERER_GONE"
  | "DESKTOP_SHUTDOWN_FAILED"
  | "DESKTOP_STOPPED";

/** Fixed codes only: no exception objects, paths, titles, URLs, document text or keys. */
export class OperationalLog {
  constructor(private readonly directory: string) {}

  write(code: OperationalCode): void {
    try {
      mkdirSync(this.directory, { recursive: true });
      const target = path.join(this.directory, "operations.jsonl");
      try {
        if (statSync(target).size >= 64 * 1024)
          renameSync(
            target,
            path.join(this.directory, "operations.previous.jsonl"),
          );
      } catch {
        // Missing file is normal. Logging must never block startup or cleanup.
      }
      appendFileSync(
        target,
        `${JSON.stringify({ time: new Date().toISOString(), code })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Disk/permission failures never bypass encryption or fail the application.
    }
  }
}
