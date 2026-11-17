import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createDefaultSettings,
  failure,
  workerCommandSchema,
  type ActivityEvent,
  type ActivityRepository,
  type AppError,
  type Result,
  type RuntimeSnapshot,
  type SessionStorage,
  type UserSettings,
  type WorkerCommand,
  type StorageUsage,
} from "@rewind/contracts";
import { SessionCoordinator, SessionService } from "@rewind/engine";
import {
  WindowsCollector,
  ProtectedFolderCollector,
  type WindowQueryStrategy,
} from "@rewind/collectors";
import { FileOperations } from "./file-operations";
import { RecoveryOperations } from "./recovery-operations";
import { CheckpointOperations } from "./checkpoint-operations";
import { SecureStorage } from "@rewind/storage";
import {
  preparePrivateDirectory,
  secureDatabaseName,
} from "@rewind/storage/key-store";

export interface WorkerRuntimeOptions {
  root: string;
  key: Uint8Array;
  synthetic: boolean;
  onSnapshot: (snapshot: RuntimeSnapshot) => void;
  onActivity: (sessionId: string) => void;
  strategy?: WindowQueryStrategy;
}

/** Privileged worker composition only; fixture observations are explicit and visibly labelled. */
export class WorkerRuntime {
  private readonly storage: SecureStorage;
  private coordinator: SessionCoordinator | null = null;
  private settings: UserSettings = createDefaultSettings();
  private ready = false;
  private closing = false;
  private fault: AppError | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenancePending = false;
  private preferenceRevision = 0;
  private files: FileOperations | null = null;
  private recovery: RecoveryOperations | null = null;
  private checkpoints: CheckpointOperations | null = null;
  constructor(private readonly options: WorkerRuntimeOptions) {
    this.storage = new SecureStorage(
      path.join(options.root, secureDatabaseName),
      options.key,
    );
    options.key.fill(0);
  }
  snapshot(): RuntimeSnapshot {
    const health = this.coordinator?.getStatus();
    return {
      service: this.closing
        ? "stopping"
        : this.fault || health?.unavailable
          ? "unavailable"
          : this.ready
            ? "ready"
            : "starting",
      collection:
        this.fault || health?.unavailable
          ? "unavailable"
          : (health?.collection ?? "off"),
      session: this.coordinator?.getState().session ?? null,
      preferences: {
        collectionConsent: this.settings.collectionConsent,
        excludedApplications: [...this.settings.excludedApplications],
      },
      secureStorage: this.ready,
      filePermission: this.settings.folderCollectionConsent,
      synthetic: this.options.synthetic,
      error:
        this.fault ??
        (health?.error?.code === "STORAGE_LIMIT"
          ? {
              code: "STORAGE_LIMIT",
              message:
                "File capture needs more free space or a larger quota. Adjust storage in Settings before approving capture again.",
            }
          : (health?.error ?? null)),
      revision: 0,
    };
  }
  async initialize(): Promise<Result<RuntimeSnapshot>> {
    try {
      await preparePrivateDirectory(this.options.root);
      const opened = await this.storage.open();
      if (!opened.ok) return await this.initializationFailure(opened.error);
      const settings = await this.storage.getSettings();
      if (!settings.ok) return await this.initializationFailure(settings.error);
      // Permission expires with this worker lifetime. Exclusions persist; every launch needs a fresh grant.
      this.settings = {
        ...settings.value,
        collectionConsent: false,
        folderCollectionConsent: false,
        cloudAiEnabled: false,
        articleExtractionEnabled: false,
      };
      const saved = await this.storage.saveSettings(this.settings);
      if (!saved.ok) return await this.initializationFailure(saved.error);
      const recovered = await this.storage.recoverInterrupted(
        new Date().toISOString(),
      );
      if (!recovered.ok)
        return await this.initializationFailure(recovered.error);
      const cleaned = await this.storage.cleanup();
      if (!cleaned.ok) return await this.initializationFailure(cleaned.error);
      let syntheticSequence = 0;
      const strategy =
        this.options.strategy ??
        (this.options.synthetic
          ? {
              getActiveWindow: async () => ({
                application: "SyntheticEditor.exe",
                windowTitle: `Synthetic work item ${++syntheticSequence} — encrypted recording fixture`,
              }),
            }
          : undefined);
      const windows = new WindowsCollector({
        ...(strategy ? { strategy } : {}),
        pollIntervalMs: this.options.synthetic ? 75 : 2000,
      });
      const actualStorage = this.storage;
      const notify = this.options.onActivity;
      const engineStorage: SessionStorage = {
        open: () => actualStorage.open(),
        close: () => actualStorage.close(),
        get repositories() {
          const repositories = actualStorage.repositories;
          return {
            sessions: repositories.sessions,
            activities: {
              append: async (events: readonly ActivityEvent[]) => {
                let admitted = await actualStorage.usage();
                if (!admitted.ok) return admitted;
                if (admitted.value.overQuota)
                  admitted = await actualStorage.cleanup();
                if (!admitted.ok) return admitted;
                if (admitted.value.overQuota)
                  return failure(
                    "UNAVAILABLE",
                    "Storage quota reached. Clean up history or increase the limit before recording.",
                  );
                const result = await repositories.activities.append(events);
                if (result.ok) {
                  const used = await actualStorage.usage();
                  if (!used.ok) return used;
                  if (used.value.overQuota) {
                    const cleaned = await actualStorage.cleanup();
                    if (!cleaned.ok) return cleaned;
                    if (cleaned.value.overQuota)
                      return failure(
                        "UNAVAILABLE",
                        "Kept evidence or storage overhead exceeds the quota. Recording has stopped.",
                      );
                  }
                }
                if (result.ok)
                  for (const sessionId of new Set(
                    events.map((event) => event.sessionId),
                  )) {
                    try {
                      notify(sessionId);
                    } catch {
                      /* Notification cannot undo a committed write. */
                    }
                  }
                return result;
              },
              list: (...args: Parameters<ActivityRepository["list"]>) =>
                repositories.activities.list(...args),
            },
          };
        },
      };
      const folders = new ProtectedFolderCollector({
        getFolders: () => this.storage.snapshots.listFolders(),
        resolveFileId: (folderId, relativePath) =>
          this.storage.snapshots.resolveFileId(folderId, relativePath),
        onChanged: () => {
          if (this.ready) this.options.onSnapshot(this.snapshot());
        },
      });
      this.coordinator = new SessionCoordinator({
        mode: "repository",
        storage: engineStorage,
        service: new SessionService({
          newId: randomUUID,
          now: () => new Date().toISOString(),
        }),
        collectors: { windows, folders },
        getSettings: () => this.settings,
        authorizeResource: async (event, settings) => {
          if (event.type !== "file-change")
            return failure("FORBIDDEN", "This resource source is unavailable.");
          const capture = await folders.captureFor(event, settings);
          return capture.ok ? { ok: true, value: undefined } : capture;
        },
        fileCaptures: {
          get: (event, settings) => folders.captureFor(event, settings),
          save: async (capture, event, authorized) => {
            const saved = await this.storage.snapshots.capture(
              capture,
              event,
              authorized,
            );
            if (saved.ok) {
              try {
                this.options.onActivity(event.sessionId);
              } catch {
                /* Notifications cannot undo publication. */
              }
            }
            return saved;
          },
        },
        onChanged: () => {
          if (this.ready) this.options.onSnapshot(this.snapshot());
        },
      });
      this.files = new FileOperations({
        storage: this.storage,
        folders,
        coordinator: this.coordinator,
        root: this.options.root,
        synthetic: this.options.synthetic,
        getSettings: () => this.settings,
        changeSettings: async (candidate, write) => {
          if (!candidate.folderCollectionConsent)
            this.settings = {
              ...this.settings,
              folderCollectionConsent: false,
            };
          const updated = await this.coordinator!.updateSettings(
            candidate,
            async () => {
              if (write) {
                const written = await write();
                if (!written.ok) return written;
              }
              const saved = await this.storage.saveSettings(candidate);
              if (saved.ok) this.settings = candidate;
              return saved;
            },
          );
          if (!updated.ok) {
            this.settings = {
              ...this.settings,
              collectionConsent: false,
              folderCollectionConsent: false,
            };
            return updated;
          }
          return { ok: true, value: undefined };
        },
      });
      this.recovery = new RecoveryOperations({
        storage: this.storage,
        coordinator: this.coordinator,
        root: this.options.root,
        synthetic: this.options.synthetic,
        storageError: (error) => {
          this.readResult({ ok: false, error });
        },
      });
      this.checkpoints = new CheckpointOperations(
        this.storage,
        this.coordinator,
      );
      const initialized = await this.coordinator.initialize();
      if (!initialized.ok)
        return await this.initializationFailure(initialized.error);
      this.ready = true;
      this.maintenanceTimer = setInterval(
        () => void this.automaticCleanup(),
        60_000,
      );
      this.maintenanceTimer.unref();
      return { ok: true, value: this.snapshot() };
    } catch {
      return await this.initializationFailure({
        code: "UNAVAILABLE",
        message: "The secure recording service could not initialize.",
      });
    }
  }
  private async initializationFailure(error: AppError): Promise<Result<never>> {
    this.fault = error;
    await this.storage.close();
    return { ok: false, error };
  }
  async execute(input: WorkerCommand): Promise<Result<unknown>> {
    const parsed = workerCommandSchema.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Worker command is invalid.");
    const command = parsed.data;
    if (command.kind === "snapshot")
      return { ok: true, value: this.snapshot() };
    if (command.kind === "shutdown") return this.shutdown();
    if (!this.ready || !this.coordinator || this.fault)
      return failure(
        "UNAVAILABLE",
        "The secure recording service is unavailable.",
      );
    try {
      switch (command.kind) {
        case "checkpoints.create":
        case "checkpoints.view":
        case "checkpoints.list":
        case "checkpoints.update":
        case "checkpoints.delete": {
          const result = await this.checkpoints!.execute(command);
          return this.readResult(result);
        }
        case "recovery.choose-copy":
        case "recovery.prepare-copy":
        case "recovery.confirm-copy":
        case "recovery.cancel":
          return await this.recovery!.execute(command);
        case "files.state":
        case "files.select":
        case "files.add":
        case "files.permission":
        case "files.remove":
        case "versions.list":
        case "versions.info":
        case "versions.preview": {
          const mutation =
            command.kind === "files.add" ||
            command.kind === "files.permission" ||
            command.kind === "files.remove";
          const revision = mutation
            ? ++this.preferenceRevision
            : this.preferenceRevision;
          const result = await this.files!.execute(
            command,
            () => !mutation || revision === this.preferenceRevision,
          );
          return command.kind.startsWith("versions.")
            ? this.readResult(result)
            : result;
        }
        case "storage.usage":
          return this.coordinator.read(() => this.storage.usage());
        case "storage.update":
        case "storage.cleanup":
        case "storage.delete": {
          this.preferenceRevision++;
          const candidate = {
            ...this.settings,
            ...(command.kind === "storage.update" ? command.value : {}),
            collectionConsent: false,
            folderCollectionConsent: false,
          };
          this.settings = candidate;
          let outcome: Result<StorageUsage> = failure(
            "UNAVAILABLE",
            "Storage maintenance did not complete.",
          );
          const stopped = await this.coordinator.updateSettings(
            candidate,
            async () => {
              const saved = await this.storage.saveSettings(candidate);
              if (!saved.ok) return saved;
              outcome =
                command.kind === "storage.delete"
                  ? await this.storage.deleteHistory(command.value)
                  : await this.storage.cleanup();
              return outcome.ok ? { ok: true, value: undefined } : outcome;
            },
          );
          if (!stopped.ok) return stopped;
          if (this.snapshot().session)
            this.options.onActivity(this.snapshot().session!.id);
          return outcome;
        }
        case "session":
          return await this.coordinator.execute(command.action);
        case "preferences.get":
          return { ok: true, value: this.snapshot().preferences };
        case "preferences.update": {
          const revision = ++this.preferenceRevision;
          if (command.value.collectionConsent) {
            const available = await this.coordinator.read(() =>
              this.storage.cleanup(),
            );
            if (!available.ok) return this.readResult(available);
            if (available.value.overQuota)
              return failure(
                "UNAVAILABLE",
                "Storage quota exceeded. Delete unneeded kept checkpoints or increase the limit before approving recording.",
              );
            if (revision !== this.preferenceRevision)
              return failure(
                "CONFLICT",
                "A newer privacy operation superseded this approval.",
              );
          }
          const candidate: UserSettings = {
            ...this.settings,
            ...command.value,
            ...(!command.value.collectionConsent
              ? { folderCollectionConsent: false }
              : {}),
          };
          if (!candidate.collectionConsent) this.settings = candidate;
          const updated = await this.coordinator.updateSettings(
            candidate,
            async () => {
              const result = await this.storage.saveSettings(candidate);
              if (result.ok) this.settings = candidate;
              return result;
            },
          );
          if (!updated.ok) {
            this.settings = {
              ...this.settings,
              collectionConsent: false,
              folderCollectionConsent: false,
            };
            return updated;
          }
          return { ok: true, value: this.snapshot().preferences };
        }
        case "timeline":
          return this.readResult(
            await this.coordinator.read(() =>
              this.freshTimeline(command.query),
            ),
          );
        case "history":
          return this.readResult(
            await this.coordinator.read(() =>
              this.storage.history(command.query),
            ),
          );
      }
    } catch {
      this.fault = {
        code: "UNAVAILABLE",
        message: "The secure recording operation failed.",
      };
      this.settings.collectionConsent = false;
      this.settings.folderCollectionConsent = false;
      void this.coordinator.revokeConsent();
      return { ok: false, error: this.fault };
    } finally {
      this.options.onSnapshot(this.snapshot());
    }
  }
  private async freshTimeline(query: Parameters<SecureStorage["timeline"]>[0]) {
    const cleaned = await this.storage.cleanup();
    return cleaned.ok ? this.storage.timeline(query) : cleaned;
  }
  private async automaticCleanup(): Promise<void> {
    if (
      this.maintenancePending ||
      !this.ready ||
      this.closing ||
      !this.coordinator
    )
      return;
    this.maintenancePending = true;
    try {
      const result = await this.coordinator.read(() => this.storage.cleanup());
      if (!result.ok || result.value.overQuota) {
        this.settings.collectionConsent = false;
        this.settings.folderCollectionConsent = false;
        await this.coordinator.revokeConsent();
        if (!result.ok) this.readResult(result);
      }
      const session = this.snapshot().session;
      if (session) this.options.onActivity(session.id);
    } finally {
      this.maintenancePending = false;
      this.options.onSnapshot(this.snapshot());
    }
  }
  private readResult<T>(result: Result<T>): Result<T> {
    if (
      !result.ok &&
      ["UNAVAILABLE", "INTEGRITY_FAILURE", "INTERNAL"].includes(
        result.error.code,
      )
    ) {
      this.fault = result.error;
      this.ready = false;
      this.settings.collectionConsent = false;
      this.settings.folderCollectionConsent = false;
      void this.coordinator?.revokeConsent();
    }
    return result;
  }
  async shutdown(): Promise<Result<true>> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.closing = true;
    this.settings.collectionConsent = false;
    this.settings.folderCollectionConsent = false;
    const recoveryStopped = await this.recovery?.close();
    if (recoveryStopped && !recoveryStopped.ok) return recoveryStopped;
    const stopped = this.coordinator
      ? await this.coordinator.shutdown()
      : await this.storage.close();
    if (!stopped.ok) {
      this.fault = stopped.error;
      return stopped;
    }
    this.ready = false;
    return { ok: true, value: true };
  }
}
