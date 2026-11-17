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
import { WindowsCollector, type WindowQueryStrategy } from "@rewind/collectors";
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
      synthetic: this.options.synthetic,
      error: this.fault ?? health?.error ?? null,
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
      this.coordinator = new SessionCoordinator({
        mode: "repository",
        storage: engineStorage,
        service: new SessionService({
          newId: randomUUID,
          now: () => new Date().toISOString(),
        }),
        collectors: { windows },
        getSettings: () => this.settings,
        onChanged: () => {
          if (this.ready) this.options.onSnapshot(this.snapshot());
        },
      });
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
            this.settings = { ...this.settings, collectionConsent: false };
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
    if (!result.ok && result.error.code !== "INVALID_INPUT") {
      this.fault = result.error;
      this.ready = false;
      this.settings.collectionConsent = false;
      void this.coordinator?.revokeConsent();
    }
    return result;
  }
  async shutdown(): Promise<Result<true>> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.closing = true;
    this.settings.collectionConsent = false;
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
