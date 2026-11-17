import { createHash, randomUUID } from "node:crypto";
import { win32 as path } from "node:path";
import {
  failure,
  type ActivityEvent,
  type Collector,
  type CollectorContext,
  type FolderCaptureStatus,
  type ProtectedFileAccess,
  type ProtectedFolder,
  type Result,
  type SnapshotCapture,
  type UserSettings,
} from "@rewind/contracts";
import { WindowsProtectedFileAccess } from "./windows-file-access";

interface Options {
  getFolders: () => Promise<Result<ProtectedFolder[]>>;
  createAccess?: () => ProtectedFileAccess;
  intervalMs?: number;
  onChanged?: () => void;
  resolveFileId: (
    folderId: string,
    relativePath: string,
  ) => Promise<Result<string | null>>;
}
const ok = (): Result<void> => ({ ok: true, value: undefined });
const types: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".html": "text/html",
  ".xml": "text/xml",
  ".csv": "text/csv",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".sql": "text/sql",
  ".py": "text/plain",
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function excluded(absolute: string, settings: Readonly<UserSettings>): boolean {
  return settings.excludedFolderPaths.some((root) => {
    const relative = path.relative(root.toLowerCase(), absolute.toLowerCase());
    return (
      !relative ||
      (relative !== ".." &&
        !relative.startsWith("..\\") &&
        !path.isAbsolute(relative))
    );
  });
}
/** Handle-verified periodic reconciliation. Signals never authorize a path or imply user attention. */
export class ProtectedFolderCollector implements Collector {
  readonly id = "folders";
  private epoch = 0;
  private context: CollectorContext | null = null;
  private access: ProtectedFileAccess | null = null;
  private roots: ProtectedFolder[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private work: Promise<Result<void>> | null = null;
  private releasing: Promise<Result<void>> | null = null;
  private readonly staged = new Map<
    string,
    { context: CollectorContext; capture: SnapshotCapture }
  >();
  private readonly seen = new Map<
    string,
    { stamp: string; hash: string | null; readAt: number; confirmedAt: number }
  >();
  private state: FolderCaptureStatus = {
    state: "off",
    captured: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    issue: null,
  };
  constructor(private readonly options: Options) {}
  status(): FolderCaptureStatus {
    return { ...this.state };
  }
  private notify() {
    try {
      this.options.onChanged?.();
    } catch {
      /* Observers cannot authorize capture. */
    }
  }
  private current(context: CollectorContext): boolean {
    return this.context === context && context.settings.folderCollectionConsent;
  }
  async start(context: CollectorContext): Promise<Result<void>> {
    const ticket = ++this.epoch;
    const released = await this.release();
    if (!released.ok) return released;
    if (ticket !== this.epoch)
      return failure("FORBIDDEN", "Folder startup was superseded by a stop.");
    if (!context.settings.folderCollectionConsent) return ok();
    const folders = await this.options.getFolders();
    if (!folders.ok) return folders;
    if (ticket !== this.epoch)
      return failure("FORBIDDEN", "Folder startup authority expired.");
    this.roots = folders.value.filter(
      (root) =>
        context.settings.protectedFolderIds.includes(root.id) &&
        !excluded(root.absolutePath, context.settings),
    );
    if (!this.roots.length)
      return failure(
        "FORBIDDEN",
        "Choose an available protected folder before approving file capture.",
      );
    this.access = (
      this.options.createAccess ?? (() => new WindowsProtectedFileAccess())
    )();
    this.context = context;
    this.seen.clear();
    this.state = {
      state: "pending",
      captured: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      issue: null,
    };
    this.schedule(0);
    this.notify();
    return ok();
  }
  resume(context: CollectorContext): Promise<Result<void>> {
    return this.start(context);
  }
  pause(): Promise<Result<void>> {
    return this.stop();
  }
  stop(): Promise<Result<void>> {
    this.epoch++;
    return this.release();
  }
  private release(): Promise<Result<void>> {
    this.context = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.releasing) return this.releasing;
    this.releasing = this.finishRelease()
      .catch(() =>
        failure("UNAVAILABLE", "Protected-file cleanup did not complete."),
      )
      .finally(() => {
        this.releasing = null;
      });
    return this.releasing;
  }
  private async finishRelease(): Promise<Result<void>> {
    const access = this.access;
    const closing = access?.close();
    if (this.work) await this.work;
    const closed = await closing;
    if (!closed || closed.ok) this.access = null;
    this.staged.clear();
    this.seen.clear();
    this.roots = [];
    this.state = {
      ...this.state,
      state: closed && !closed.ok ? "unavailable" : "off",
      pending: 0,
    };
    this.notify();
    return closed ?? ok();
  }
  private schedule(delay = this.options.intervalMs ?? 2000) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
    this.timer.unref();
  }
  poll(): Promise<Result<void>> {
    if (this.work) return this.work;
    const context = this.context;
    if (!context || !this.current(context))
      return Promise.resolve(
        failure("FORBIDDEN", "Folder capture is stopped."),
      );
    const work = this.perform(context).catch(() =>
      this.gap(context, "unavailable"),
    );
    this.work = work;
    void work.finally(() => {
      if (this.work === work) this.work = null;
      if (this.current(context) && this.state.state !== "unavailable")
        this.schedule();
    });
    return work;
  }
  private async gap(
    context: CollectorContext,
    reason: "unavailable" | "overflow",
  ): Promise<Result<void>> {
    this.state = {
      ...this.state,
      state: "unavailable",
      issue:
        reason === "overflow"
          ? "Folder enumeration exceeded the supported limit. Choose a smaller folder."
          : "A protected folder is unavailable or its identity changed. Select it again before resuming.",
    };
    this.notify();
    if (this.current(context)) {
      try {
        await context.emit([
          {
            id: randomUUID(),
            sessionId: context.sessionId,
            occurredAt: new Date().toISOString(),
            source: "filesystem",
            type: "capture-gap",
            payload: { collectorId: this.id, reason },
          },
        ]);
      } catch {
        /* Failure remains explicit; failed ingress is fenced by the coordinator. */
      }
    }
    return failure("UNAVAILABLE", "Protected-folder capture is unavailable.");
  }
  private async perform(context: CollectorContext): Promise<Result<void>> {
    const access = this.access;
    if (!access)
      return failure("UNAVAILABLE", "Protected-file access is unavailable.");
    const pending: {
      folder: ProtectedFolder;
      relative: string;
      stamp: string;
    }[] = [];
    for (const folder of this.roots) {
      if (!this.current(context))
        return failure("FORBIDDEN", "Folder capture authority expired.");
      const listed = await access.list(folder);
      if (!this.current(context))
        return failure("FORBIDDEN", "Folder capture authority expired.");
      if (!listed.ok) return this.gap(context, "unavailable");
      if (
        listed.value.overflow ||
        pending.length + listed.value.paths.length > 2000
      )
        return this.gap(context, "overflow");
      for (const [index, relative] of listed.value.paths.entries())
        pending.push({ folder, relative, stamp: listed.value.stamps[index]! });
    }
    this.state = { ...this.state, state: "capturing", pending: pending.length };
    const present = new Set(
      pending.map((entry) => `${entry.folder.id}\0${entry.relative}`),
    );
    for (const key of this.seen.keys())
      if (!present.has(key)) this.seen.delete(key);
    this.notify();
    for (const entry of pending) {
      if (!this.current(context))
        return failure("FORBIDDEN", "Folder capture authority expired.");
      const absolute = path.join(entry.folder.absolutePath, entry.relative);
      const key = `${entry.folder.id}\0${entry.relative}`;
      const previous = this.seen.get(key);
      const mediaType =
        types[path.extname(entry.relative).toLowerCase()] ??
        (["readme", "license", "makefile"].includes(
          path.basename(entry.relative).toLowerCase(),
        )
          ? "text/plain"
          : undefined);
      this.state.pending--;
      if (excluded(absolute, context.settings) || !mediaType) {
        if (!previous) this.state.skipped++;
        this.seen.set(key, {
          stamp: entry.stamp,
          hash: null,
          readAt: Date.now(),
          confirmedAt: 0,
        });
        continue;
      }
      if (
        previous?.stamp === entry.stamp &&
        Date.now() - previous.readAt < 60_000
      )
        continue;
      const read = await access.read(entry.folder, entry.relative);
      if (!this.current(context)) {
        if (read.ok) read.value.bytes.fill(0);
        return failure(
          "FORBIDDEN",
          "Folder capture authority expired after read.",
        );
      }
      if (!read.ok) {
        this.state.failed++;
        this.state.issue =
          "Some files could not be captured: they may be locked, oversized or outside the supported path policy.";
        this.notify();
        continue;
      }
      const bytes = read.value.bytes;
      try {
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (
          previous?.hash === hash &&
          Date.now() - previous.confirmedAt <
            (context.settings.retentionHours * 3600_000) / 2
        ) {
          this.seen.set(key, {
            ...previous,
            stamp: entry.stamp,
            hash,
            readAt: Date.now(),
          });
          continue;
        }
        const resolved = await this.options.resolveFileId(
          entry.folder.id,
          entry.relative,
        );
        if (!this.current(context))
          return failure("FORBIDDEN", "File identity authorization expired.");
        if (!resolved.ok) return this.gap(context, "unavailable");
        const id = resolved.value ?? randomUUID(),
          at = new Date().toISOString();
        const event: ActivityEvent = {
          id: randomUUID(),
          sessionId: context.sessionId,
          occurredAt: at,
          source: "filesystem",
          type: "file-change",
          payload: {
            fileId: id,
            displayName: path.basename(entry.relative),
            change: previous && previous.hash !== hash ? "updated" : "captured",
          },
        };
        const capture: SnapshotCapture = {
          file: {
            id,
            displayName: path.basename(entry.relative),
            identity: {
              kind: "verified-path",
              absolutePath: absolute,
              verifiedAt: at,
            },
          },
          version: {
            id: randomUUID(),
            sessionId: context.sessionId,
            fileId: id,
            capturedAt: at,
            contentHash: hash,
            byteLength: bytes.byteLength,
            mediaType,
          },
          binding: {
            folderId: entry.folder.id,
            relativePath: entry.relative,
            osIdentity: read.value.osIdentity,
          },
          bytes,
        };
        this.staged.set(event.id, { context, capture });
        const saved = await context.emit([event]);
        if (!this.current(context))
          return failure(
            "FORBIDDEN",
            "Folder capture stopped during publication.",
          );
        if (saved.ok) {
          this.state.captured++;
          this.seen.set(key, {
            stamp: entry.stamp,
            hash,
            readAt: Date.now(),
            confirmedAt: Date.now(),
          });
        } else {
          context.reportUnavailable?.();
          this.state.failed++;
          this.state.issue =
            "A saved version could not be confirmed. Review the recording service status.";
          this.state.state = "unavailable";
          this.context = null;
          this.staged.delete(event.id);
          await access.close();
          this.notify();
          return saved;
        }
        this.staged.delete(event.id);
        this.notify();
      } finally {
        bytes.fill(0);
      }
    }
    if (this.current(context)) {
      this.state = { ...this.state, state: "watching", pending: 0 };
      this.notify();
    }
    return ok();
  }
  async captureFor(
    event: ActivityEvent,
    settings: Readonly<UserSettings>,
  ): Promise<Result<SnapshotCapture>> {
    const staged = this.staged.get(event.id);
    if (
      !staged ||
      !this.current(staged.context) ||
      !settings.folderCollectionConsent ||
      !settings.protectedFolderIds.includes(staged.capture.binding.folderId) ||
      staged.capture.file.identity.kind !== "verified-path" ||
      excluded(staged.capture.file.identity.absolutePath, settings)
    )
      return failure("FORBIDDEN", "File capture scope is no longer approved.");
    return { ok: true, value: staged.capture };
  }
}
