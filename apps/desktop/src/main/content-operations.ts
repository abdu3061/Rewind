import { win32 } from "node:path";
import {
  failure,
  fileTextIndexRequestSchema,
  type AppError,
  type CapturedVersionSummary,
  type DocumentAuthority,
  type DocumentProcessor,
  type FileTextCandidate,
  type FileTextCommand,
  type FileTextControlState,
  type FileTextIndexRequest,
  type FileTextQuery,
  type FileTextRunScope,
  type FileTextSearchReceipt,
  type Result,
  type Session,
  type UserSettings,
} from "@rewind/contracts";
import {
  FileTextIndexer,
  isExcludedPath,
  type SessionCoordinator,
} from "@rewind/engine";
import type { SecureStorage } from "@rewind/storage";

interface Options {
  storage: SecureStorage;
  coordinator: SessionCoordinator;
  documents?: DocumentProcessor;
  authority(): DocumentAuthority;
  settings(): UserSettings;
  session(): Session | null;
  available(): boolean;
  indexingAllowed(): boolean;
  automaticAllowed(): boolean;
  previewActive(): boolean;
  changed(): void;
  fault(error: AppError): void;
}
const sameAuthority = (a: DocumentAuthority, b: DocumentAuthority) =>
  a.generation === b.generation && a.revision === b.revision;
const sameCandidate = (a: FileTextCandidate, b: FileTextCandidate) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Retained encrypted content only. No filesystem, provider or renderer-supplied body authority. */
export class ContentOperations {
  private readonly indexer: FileTextIndexer;
  private readonly timer: ReturnType<typeof setInterval>;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private selected = new Set<string>();
  private queryRevision = 0;
  private pendingQuery = false;
  private automaticPaused = false;
  private admitting = false;
  private closing = false;
  private reported: AppError | null = null;
  constructor(private readonly options: Options) {
    const { storage, coordinator } = options;
    this.indexer = new FileTextIndexer({
      now: () => new Date().toISOString(),
      ...(options.documents ? { documents: options.documents } : {}),
      next: (query) =>
        coordinator.read(async () => {
          const clean = await storage.cleanup();
          return clean.ok ? storage.fileText.next(query) : clean;
        }),
      read: (candidate) =>
        coordinator.read(async () => {
          const clean = await storage.cleanup();
          if (!clean.ok) return clean;
          const fresh = await storage.fileText.candidate(candidate.version.id);
          if (!fresh.ok) return fresh;
          if (!fresh.value)
            return failure(
              "NOT_FOUND",
              "The indexed source is no longer retained.",
            );
          if (!sameCandidate(fresh.value, candidate))
            return failure(
              "INTEGRITY_FAILURE",
              "The indexed source identity changed.",
            );
          if (!this.allowed(candidate))
            return failure(
              "FORBIDDEN",
              "The captured source is excluded from content indexing.",
            );
          return storage.snapshots.read(candidate.version.id);
        }),
      publish: (write, authorized, candidate) =>
        coordinator.read(async () => {
          const clean = await storage.cleanup();
          if (!clean.ok) return clean;
          const fresh = await storage.fileText.candidate(write.versionId);
          if (!fresh.ok) return fresh;
          if (!fresh.value)
            return failure(
              "NOT_FOUND",
              "The extracted source is no longer retained.",
            );
          if (!sameCandidate(fresh.value, candidate))
            return failure(
              "INTEGRITY_FAILURE",
              "The extracted source identity changed.",
            );
          return storage.fileText.save(
            write,
            () => authorized() && this.allowed(fresh.value!),
          );
        }),
      authorized: (scope, candidate) => this.authorized(scope, candidate),
      onChanged: (state) => {
        if (state.error !== this.reported) {
          this.reported = state.error;
          if (
            state.error &&
            ["INTEGRITY_FAILURE", "UNAVAILABLE", "INTERNAL"].includes(
              state.error.code,
            )
          )
            options.fault(state.error);
        }
        options.changed();
      },
    });
    this.timer = setInterval(() => this.kick(), 5000);
    this.timer.unref();
  }
  private available(): boolean {
    return !this.closing && this.options.available();
  }
  private allowed(source: CapturedVersionSummary): boolean {
    return (
      this.available() &&
      win32.isAbsolute(source.sourceLabel) &&
      !isExcludedPath(
        source.sourceLabel,
        this.options.settings().excludedFolderPaths,
      )
    );
  }
  private authorized(
    scope: FileTextRunScope,
    candidate?: FileTextCandidate,
  ): boolean {
    if (
      !this.available() ||
      !this.options.indexingAllowed() ||
      (candidate && !this.allowed(candidate))
    )
      return false;
    if (scope.mode === "saved") return true;
    const settings = this.options.settings(),
      session = this.options.session();
    return (
      this.options.automaticAllowed() &&
      !this.automaticPaused &&
      settings.folderCollectionConsent &&
      session?.status === "active" &&
      session.id === scope.query.sessionId &&
      scope.query.folderIds.every((id) =>
        settings.protectedFolderIds.includes(id),
      ) &&
      (!candidate ||
        (candidate.folderId !== null &&
          settings.protectedFolderIds.includes(candidate.folderId)))
    );
  }
  /** Called after a confirmed capture commit; starts outside its coordinator callback. */
  kick(): void {
    if (
      this.kickTimer ||
      this.admitting ||
      this.closing ||
      this.automaticPaused ||
      this.indexer.state().busy ||
      this.options.previewActive()
    )
      return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      const settings = this.options.settings(),
        session = this.options.session();
      if (
        !session ||
        !settings.protectedFolderIds.length ||
        this.admitting ||
        this.options.previewActive()
      )
        return;
      const scope: FileTextRunScope = {
        mode: "automatic",
        query: {
          through: new Date().toISOString(),
          retryFailures: false,
          sessionId: session.id,
          folderIds: [...settings.protectedFolderIds],
        },
      };
      if (this.authorized(scope)) this.indexer.start(scope);
    }, 0);
    this.kickTimer.unref();
  }
  clearSearch(): void {
    this.queryRevision++;
    this.pendingQuery = false;
    this.selected.clear();
  }
  invalidate(): void {
    this.clearSearch();
    this.indexer.invalidate();
  }
  referencesRemoved(retainsVersion: (id: string) => boolean): boolean {
    return (
      this.pendingQuery ||
      this.indexer.referencesRemoved(retainsVersion) ||
      [...this.selected].some((id) => !retainsVersion(id))
    );
  }
  /** Safe inside the coordinator: only parser closure, never queued index settlement. */
  drain(): Promise<boolean> {
    this.indexer.invalidate();
    return this.indexer.stop();
  }
  private state(): Promise<Result<FileTextControlState>> {
    return this.options.coordinator.read(async () => {
      const clean = await this.options.storage.cleanup();
      if (!clean.ok) return clean;
      const counts = await this.options.storage.fileText.counts();
      return counts.ok
        ? {
            ok: true,
            value: {
              authority: this.options.authority(),
              counts: counts.value,
              indexing: this.indexer.state(),
              automaticPaused: this.automaticPaused,
            },
          }
        : counts;
    });
  }
  private async indexSaved(
    input: FileTextIndexRequest,
  ): Promise<Result<FileTextControlState>> {
    const parsed = fileTextIndexRequestSchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_INPUT",
        "Explicit saved-content indexing approval is required.",
      );
    if (
      this.admitting ||
      (this.indexer.state().busy && this.indexer.state().mode === "saved")
    )
      return failure(
        "CONFLICT",
        "Saved content indexing is already running or closing.",
      );
    const authority = this.options.authority();
    this.admitting = true;
    try {
      if (!(await this.indexer.stop()))
        return failure(
          "CONFLICT",
          "The previous content parser did not confirm shutdown.",
        );
      await this.indexer.settled();
      if (
        !sameAuthority(authority, this.options.authority()) ||
        !this.available()
      )
        return failure(
          "CONFLICT",
          "A newer privacy operation superseded content indexing.",
        );
      const started = this.indexer.start({
        mode: "saved",
        query: {
          through: new Date().toISOString(),
          retryFailures: parsed.data.retryFailures,
        },
      });
      if (!started.ok) return started;
      this.automaticPaused = false;
      return this.state();
    } finally {
      this.admitting = false;
    }
  }
  private async search(
    query: FileTextQuery,
  ): Promise<Result<FileTextSearchReceipt>> {
    const ticket = ++this.queryRevision;
    this.pendingQuery = true;
    this.selected.clear();
    try {
      return await this.options.coordinator.read(async () => {
        const clean = await this.options.storage.cleanup();
        if (!clean.ok) return clean;
        const authority = this.options.authority();
        const page = await this.options.storage.fileText.search(
          query,
          (source) => this.allowed(source),
        );
        if (!page.ok) return page;
        if (
          ticket !== this.queryRevision ||
          !this.available() ||
          !sameAuthority(authority, this.options.authority())
        )
          return failure(
            "CONFLICT",
            "Captured-content search changed. Search again.",
          );
        this.selected = new Set(page.value.hits.map((hit) => hit.version.id));
        return { ok: true, value: { ...page.value, authority } };
      });
    } finally {
      if (ticket === this.queryRevision) this.pendingQuery = false;
    }
  }
  async execute(command: FileTextCommand): Promise<Result<unknown>> {
    if (!this.available())
      return failure("UNAVAILABLE", "Captured-content search is unavailable.");
    switch (command.kind) {
      case "content.state":
        return this.state();
      case "content.index":
        return this.indexSaved(command.value);
      case "content.search":
        return this.search(command.query);
      case "content.clear-search":
        this.clearSearch();
        return { ok: true, value: true };
      case "content.stop":
        this.automaticPaused = true;
        return (await this.indexer.stop())
          ? this.state()
          : failure(
              "CONFLICT",
              "Content indexing is still closing. Try Stop again.",
            );
    }
  }
  async close(): Promise<boolean> {
    this.closing = true;
    clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
    this.clearSearch();
    return this.indexer.close();
  }
}
