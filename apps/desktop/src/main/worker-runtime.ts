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
      const strategy =
        this.options.strategy ??
        (this.options.synthetic
          ? {
              getActiveWindow: async () => ({
                application: "SyntheticEditor.exe",
                windowTitle:
                  "Synthetic work item — encrypted recording fixture",
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
                const result = await repositories.activities.append(events);
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
        case "session":
          return await this.coordinator.execute(command.action);
        case "preferences.get":
          return { ok: true, value: this.snapshot().preferences };
        case "preferences.update": {
          const candidate: UserSettings = {
            ...this.settings,
            ...command.value,
          };
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
              this.storage.timeline(command.query),
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
