import { createHash, randomUUID } from "node:crypto";
import { win32 as path } from "node:path";
import {
  failure,
  fileVersionSchema,
  type ActivityEvent,
  type Collector,
  type CollectorContext,
  type FolderCaptureStatus,
  type ProtectedFileAccess,
  type ProtectedFolder,
  type Result,
  type SnapshotCapture,
  type FileVersion,
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
  getLatestVersion: (fileId: string) => Promise<Result<FileVersion | null>>;
}
interface PendingChange {
  folder: ProtectedFolder;
  relative: string;
  stamp: string;
  attempts: number;
  nextAt: number;
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
function watchPath(value: string): string {
  // Conservative ASCII folding avoids merging distinct Unicode folder names.
  return value
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/\\+$/, "");
}
/** Change-triggered capture. Native notifications are hints, never read authority or proof of user attention. */
export class ProtectedFolderCollector implements Collector {
  readonly id = "folders";
  private epoch = 0;
  private context: CollectorContext | null = null;
  private readonly pending = new Map<string, PendingChange>();
  private access: ProtectedFileAccess | null = null;
  private roots: ProtectedFolder[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private work: Promise<Result<void>> | null = null;
  private releasing: Promise<Result<void>> | null = null;
  private readonly staged = new Map<
    string,
    { context: CollectorContext; capture: SnapshotCapture }
  >();
  private readonly seen = new Map<string, { stamp: string; hash: string }>();
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
  private remember(
    key: string,
    value: {
      stamp: string;
      hash: string;
    },
  ) {
    this.seen.delete(key);
    this.seen.set(key, value);
    // A long-running paged scan must not grow utility memory without a bound.
    if (this.seen.size > 20_000)
      this.seen.delete(this.seen.keys().next().value!);
  }
  private current(context: CollectorContext): boolean {
    return (
      this.context === context &&
      context.settings.folderCollectionConsent &&
      context.authorized?.() !== false
    );
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
    const eligible = folders.value.filter(
      (root) =>
        context.settings.protectedFolderIds.includes(root.id) &&
        !excluded(root.absolutePath, context.settings),
    );
    this.roots = eligible.filter((root, index) => {
      const current = watchPath(root.absolutePath);
      return !eligible.some((parent, parentIndex) => {
        if (parentIndex === index) return false;
        const ancestor = watchPath(parent.absolutePath);
        return (
          current.startsWith(ancestor + "\\") ||
          (current === ancestor &&
            parent.osIdentity === root.osIdentity &&
            parentIndex < index)
        );
      });
    });
    if (!this.roots.length)
      return failure(
        "FORBIDDEN",
        "Choose an available protected folder before approving file capture.",
      );
    this.access = (
      this.options.createAccess ?? (() => new WindowsProtectedFileAccess())
    )();
    const access = this.access;
    for (const root of this.roots) {
      const armed = await access.watch(root);
      if (ticket !== this.epoch)
        return failure("FORBIDDEN", "Folder startup authority expired.");
      if (!armed.ok) {
        await this.release();
        return armed;
      }
    }
    this.context = context;
    this.seen.clear();
    this.pending.clear();
    this.state = {
      state: "watching",
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
    this.pending.clear();
    this.roots = [];
    this.state = {
      ...this.state,
      state: closed && !closed.ok ? "unavailable" : "off",
      pending: 0,
    };
    this.notify();
    return closed ?? ok();
  }
  private schedule(delay = this.options.intervalMs ?? 1000) {
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
    if (
      context &&
      !this.current(context) &&
      this.context === context &&
      context.settings.folderCollectionConsent
    )
      this.schedule();
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
          ? "Too many file changes arrived at once. Recording stopped; review exclusions before resuming."
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
    for (const folder of this.roots) {
      if (!this.current(context))
        return failure("FORBIDDEN", "Folder capture authority expired.");
      const listed = await access.changes(folder);
      if (!this.current(context))
        return failure("FORBIDDEN", "Folder capture authority expired.");
      if (!listed.ok) return this.gap(context, "unavailable");
      if (listed.value.overflow) return this.gap(context, "overflow");
      if (listed.value.skipped) {
        this.state.skipped += listed.value.skipped;
        this.state.issue =
          "Some entries were skipped because they are unavailable or exceed the supported path policy. Other supported files continue recording.";
      }
      for (const [index, relative] of listed.value.paths.entries()) {
        const key = `${folder.id}\0${relative}`;
        if (!this.pending.has(key) && this.pending.size >= 2000)
          return this.gap(context, "overflow");
        const existing = this.pending.get(key);
        this.pending.set(key, {
          folder,
          relative,
          stamp: listed.value.stamps[index]!,
          attempts: existing?.attempts ?? 0,
          nextAt: existing?.nextAt ?? 0,
        });
      }
    }
    const pending = [...this.pending.values()]
      .filter((entry) => entry.nextAt <= Date.now())
      .slice(0, 32);
    if (!pending.length) return ok();
    this.state = {
      ...this.state,
      state: "capturing",
      pending: this.pending.size,
    };
    this.notify();
    let readBytes = 0;
    for (const entry of pending) {
      if (readBytes >= 32 * 1024 ** 2) break;
      if (!this.current(context))
        return failure("FORBIDDEN", "Folder capture authority expired.");
      const absolute = path.join(entry.folder.absolutePath, entry.relative);
      const key = `${entry.folder.id}\0${entry.relative}`;
      this.pending.delete(key);
      const previous = this.seen.get(key);
      const mediaType =
        types[path.extname(entry.relative).toLowerCase()] ??
        (["readme", "license", "makefile"].includes(
          path.basename(entry.relative).toLowerCase(),
        )
          ? "text/plain"
          : undefined);
      this.state.pending = this.pending.size;
      if (excluded(absolute, context.settings) || !mediaType) {
        this.state.skipped++;
        continue;
      }
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
        if (entry.attempts < 2)
          this.pending.set(key, {
            ...entry,
            attempts: entry.attempts + 1,
            nextAt: Date.now() + 1000 * (entry.attempts + 1),
          });
        continue;
      }
      const bytes = read.value.bytes;
      readBytes += bytes.byteLength;
      try {
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (previous?.hash === hash) {
          this.remember(key, { stamp: entry.stamp, hash });
          continue;
        }
        const resolved = await this.options.resolveFileId(
          entry.folder.id,
          entry.relative,
        );
        if (!this.current(context))
          return failure("FORBIDDEN", "File identity authorization expired.");
        if (!resolved.ok) return this.gap(context, "unavailable");
        if (resolved.value) {
          const latest = await this.options.getLatestVersion(resolved.value);
          if (!this.current(context))
            return failure("FORBIDDEN", "File history authority expired.");
          if (!latest.ok) return this.gap(context, "unavailable");
          if (latest.value) {
            const checked = fileVersionSchema.safeParse(latest.value);
            if (!checked.success || checked.data.fileId !== resolved.value)
              return this.gap(context, "unavailable");
            if (
              checked.data.contentHash === hash &&
              checked.data.byteLength === bytes.byteLength
            ) {
              this.remember(key, { stamp: entry.stamp, hash });
              continue;
            }
          }
        }
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
            change: "updated",
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
          this.remember(key, {
            stamp: entry.stamp,
            hash,
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
      } finally {
        bytes.fill(0);
      }
    }
    if (this.current(context)) {
      this.state = {
        ...this.state,
        state: this.pending.size ? "pending" : "watching",
        pending: this.pending.size,
      };
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
