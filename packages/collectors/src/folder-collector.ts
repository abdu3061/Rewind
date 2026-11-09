import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { basename, resolve } from "node:path";
import {
  failure,
  fileReferenceSchema,
  idSchema,
  type ActivityEvent,
  type Collector,
  type CollectorContext,
  type FileReference,
  type Id,
  type Result,
} from "@rewind/contracts";
import type { FolderCollectorOptions } from "./types";

export class FolderCollector implements Collector {
  readonly id = "folders";
  private readonly watchRoots: string[];
  private readonly debounceMs: number;
  private readonly newId: () => string;
  private readonly now: () => string;

  private activeContext: CollectorContext | null = null;
  private watchers = new Map<string, FSWatcher>();
  private debouncedEmits = new Map<string, NodeJS.Timeout>();

  constructor(options: FolderCollectorOptions = {}) {
    this.watchRoots = options.watchRoots ?? [];
    this.debounceMs = options.debounceMs ?? 300;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(context: CollectorContext): Promise<Result<void>> {
    this.stopWatchers();
    this.activeContext = context;

    if (context.settings.collectionConsent) {
      this.initWatchers();
    }

    return { ok: true, value: undefined };
  }

  async pause(): Promise<Result<void>> {
    this.stopWatchers();
    this.activeContext = null;
    return { ok: true, value: undefined };
  }

  async resume(context: CollectorContext): Promise<Result<void>> {
    this.stopWatchers();
    this.activeContext = context;

    if (context.settings.collectionConsent) {
      this.initWatchers();
    }

    return { ok: true, value: undefined };
  }

  async stop(): Promise<Result<void>> {
    this.stopWatchers();
    this.activeContext = null;
    return { ok: true, value: undefined };
  }

  async recordFileOpened(file: FileReference): Promise<Result<void>> {
    if (!this.activeContext) {
      return failure(
        "INVALID_TRANSITION",
        "Cannot record opened file: folder collector is not active.",
      );
    }

    if (!this.activeContext.settings.collectionConsent) {
      return failure(
        "FORBIDDEN",
        "Collection consent is not granted by user settings.",
      );
    }

    const validFile = fileReferenceSchema.safeParse(file);
    if (!validFile.success) {
      return failure(
        "INVALID_INPUT",
        `Invalid file reference: ${validFile.error.issues[0]?.message ?? "Validation failed"}`,
      );
    }

    // Check path exclusions
    if (file.identity.kind === "verified-path") {
      const normPath = resolve(file.identity.absolutePath).toLowerCase();
      const isExcluded = this.activeContext.settings.excludedFolderPaths.some(
        (ex) => normPath.startsWith(resolve(ex).toLowerCase()),
      );
      if (isExcluded) {
        return { ok: true, value: undefined };
      }
    }

    const currentContext = this.activeContext;
    const currentGenerationId = currentContext.generationId;

    const event: ActivityEvent = {
      id: this.newId(),
      sessionId: currentContext.sessionId,
      occurredAt: this.now(),
      source: "rewind",
      type: "file-opened",
      payload: validFile.data,
    };

    if (
      this.activeContext &&
      this.activeContext.generationId === currentGenerationId
    ) {
      return this.activeContext.emit([event]);
    }

    return failure(
      "INVALID_TRANSITION",
      "Stale generation during file-opened emit.",
    );
  }

  async recordFileChange(
    fileId: Id,
    change: "created" | "updated" | "deleted" | "renamed",
  ): Promise<Result<void>> {
    if (!this.activeContext) {
      return failure(
        "INVALID_TRANSITION",
        "Cannot record file change: folder collector is not active.",
      );
    }

    if (!this.activeContext.settings.collectionConsent) {
      return failure(
        "FORBIDDEN",
        "Collection consent is not granted by user settings.",
      );
    }

    const validId = idSchema.safeParse(fileId);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid file id: ${fileId}`);
    }

    const currentContext = this.activeContext;
    const currentGenerationId = currentContext.generationId;

    const event: ActivityEvent = {
      id: this.newId(),
      sessionId: currentContext.sessionId,
      occurredAt: this.now(),
      source: "filesystem",
      type: "file-change",
      payload: {
        fileId,
        change,
      },
    };

    if (
      this.activeContext &&
      this.activeContext.generationId === currentGenerationId
    ) {
      return this.activeContext.emit([event]);
    }

    return failure(
      "INVALID_TRANSITION",
      "Stale generation during file-change emit.",
    );
  }

  private initWatchers(): void {
    for (const root of this.watchRoots) {
      try {
        if (!existsSync(root)) continue;

        // Check if root is excluded
        const normRoot = resolve(root).toLowerCase();
        const isExcluded =
          this.activeContext?.settings.excludedFolderPaths.some((ex) =>
            normRoot.startsWith(resolve(ex).toLowerCase()),
          );
        if (isExcluded) continue;

        const watcher = watch(
          root,
          { recursive: true },
          (eventType, filename) => {
            if (filename) {
              this.handleFsEvent(root, eventType, filename);
            }
          },
        );

        watcher.on("error", () => {
          // Ignore watcher errors safely
        });

        this.watchers.set(root, watcher);
      } catch {
        // Safe ignore if root cannot be watched
      }
    }
  }

  private handleFsEvent(
    root: string,
    eventType: string,
    filename: string,
  ): void {
    if (!this.activeContext) return;
    if (!this.activeContext.settings.collectionConsent) return;

    // Filter transient/hidden/temp files
    const base = basename(filename);
    if (
      base.startsWith(".") ||
      base.startsWith("~") ||
      base.endsWith(".tmp") ||
      filename.includes(".git")
    ) {
      return;
    }

    const fullPath = resolve(root, filename);
    const normPath = fullPath.toLowerCase();

    // Check exclusions
    const isExcluded = this.activeContext.settings.excludedFolderPaths.some(
      (ex) => normPath.startsWith(resolve(ex).toLowerCase()),
    );
    if (isExcluded) return;

    // Debounce rapid writes
    const existingTimer = this.debouncedEmits.get(fullPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debouncedEmits.delete(fullPath);
      void this.emitFileChange(fullPath, eventType);
    }, this.debounceMs);

    this.debouncedEmits.set(fullPath, timer);
  }

  private async emitFileChange(
    fullPath: string,
    eventType: string,
  ): Promise<void> {
    if (!this.activeContext) return;
    const currentContext = this.activeContext;
    const currentGenerationId = currentContext.generationId;

    const fileExists = existsSync(fullPath);
    let change: "created" | "updated" | "deleted" | "renamed" = "updated";
    if (eventType === "rename") {
      change = fileExists ? "created" : "deleted";
    }

    const event: ActivityEvent = {
      id: this.newId(),
      sessionId: currentContext.sessionId,
      occurredAt: this.now(),
      source: "filesystem",
      type: "file-change",
      payload: {
        fileId: this.newId(),
        change,
      },
    };

    if (
      this.activeContext &&
      this.activeContext.generationId === currentGenerationId
    ) {
      await this.activeContext.emit([event]);
    }
  }

  private stopWatchers(): void {
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Safe ignore
      }
    }
    this.watchers.clear();

    for (const timer of this.debouncedEmits.values()) {
      clearTimeout(timer);
    }
    this.debouncedEmits.clear();
  }
}
