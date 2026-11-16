import { randomUUID } from "node:crypto";
import {
  activityEventSchema,
  createDefaultSettings,
  failure,
  idSchema,
  sessionSchema,
  userSettingsSchema,
  type ActivityEvent,
  type AppError,
  type CollectorContext,
  type CollectorRegistry,
  type Result,
  type Session,
  type SessionAction,
  type SessionState,
  type SessionStorage,
  type UserSettings,
} from "@rewind/contracts";
import { Operations } from "./operations";
import { SessionService } from "./session-service";
import { isExcluded } from "./event-exclusions";

interface CommonOptions {
  service: SessionService;
  operationTimeoutMs?: number;
  newGenerationId?: () => string;
  onChanged?: () => void;
}
export type SessionCoordinatorOptions = CommonOptions &
  (
    | { mode: "session-only" }
    | {
        mode: "repository";
        storage: SessionStorage;
        collectors: CollectorRegistry;
        getSettings: () => UserSettings;
        /** Engine authorization; a collector's path or URL assertion is insufficient. Denied if absent. */
        authorizeResource?: (
          event: ActivityEvent,
          settings: Readonly<UserSettings>,
        ) => Promise<Result<void>>;
      }
  );
export interface CoordinatorStatus {
  collection: "off" | "starting" | "active" | "stopping" | "unavailable";
  unavailable: boolean;
  shutdown: boolean;
  error: AppError | null;
}
interface Run {
  id: string;
  sessionId: string;
  settings: UserSettings;
  permissionKey: string;
}
const ok = (): Result<void> => ({ ok: true, value: undefined });
const maxCommands = 64;
const maxBatches = 32;
const maxBatchEvents = 128;
const maxBatchBytes = 256 * 1024;

/** Adapted from PR #5; lifecycle ports remain independent of Electron and native adapters. */
export class SessionCoordinator {
  private readonly operations: Operations;
  private commandTail: Promise<unknown> = Promise.resolve();
  private ingestionTail: Promise<unknown> = Promise.resolve();
  private commandCount = 0;
  private batchCount = 0;
  private cleanupPending = false;
  private epoch = 0;
  private run: Run | null = null;
  private initialized = false;
  private closing = false;
  private closed = false;
  private shutdownAttempt: Promise<Result<void>> | null = null;
  private settingsOverride: UserSettings | null = null;
  private status: CoordinatorStatus = {
    collection: "off",
    unavailable: false,
    shutdown: false,
    error: null,
  };

  constructor(private readonly options: SessionCoordinatorOptions) {
    const timeout = options.operationTimeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000)
      throw new Error("A bounded operation timeout is required.");
    this.operations = new Operations(timeout);
  }
  getState(): SessionState {
    return this.options.service.getState();
  }
  getStatus(): CoordinatorStatus {
    return structuredClone(this.status);
  }
  getActiveGenerationId(): string | null {
    return this.run?.id ?? null;
  }
  /** Authorized read-model work observes completed lifecycle transactions, never a candidate. */
  read<T>(query: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.closing)
      return Promise.resolve(
        failure("UNAVAILABLE", "Session service is shutting down."),
      );
    return this.enqueue(async () => {
      const ready = await this.initializeInternal();
      return ready.ok ? this.operations.run("History query", query) : ready;
    });
  }

  initialize(): Promise<Result<SessionState>> {
    if (this.closing)
      return Promise.resolve(
        failure("UNAVAILABLE", "Session service is shutting down."),
      );
    return this.enqueue(async () => {
      const ready = await this.initializeInternal();
      if (!ready.ok) return ready;
      return this.status.unavailable
        ? failure("UNAVAILABLE", "Session service requires recovery.")
        : { ok: true, value: this.getState() };
    }).finally(() => this.notify());
  }
  execute(action: SessionAction): Promise<Result<SessionState>> {
    if (this.closing)
      return Promise.resolve(
        failure("UNAVAILABLE", "Session service is shutting down."),
      );
    if (action === "pause" || action === "end") this.invalidate();
    const ticket = this.epoch;
    return this.enqueue(async () => {
      const ready = await this.initializeInternal();
      if (!ready.ok) return ready;
      if (action === "get")
        return this.status.unavailable
          ? failure(
              "UNAVAILABLE",
              "Session service requires a successful stop before continuing.",
            )
          : { ok: true, value: this.getState() };
      if (
        (action === "start" || action === "resume") &&
        (ticket !== this.epoch || this.status.unavailable)
      )
        return failure(
          "CONFLICT",
          "A stop or failed operation prevents this transition.",
        );
      return this.transition(action, ticket);
    }).finally(() => this.notify());
  }

  /** Apply an authoritative consent/exclusion change; never auto-resume collection. */
  updateSettings(
    settings: UserSettings,
    persist?: () => Promise<Result<void>>,
  ): Promise<Result<SessionState>> {
    this.invalidate();
    const parsed = userSettingsSchema.safeParse(settings);
    // Denial applies immediately. A new grant is installed only after stop and persistence.
    if (!parsed.success || !parsed.data.collectionConsent)
      this.settingsOverride = parsed.success
        ? structuredClone(parsed.data)
        : createDefaultSettings();
    if (!parsed.success)
      this.fail("INVALID_INPUT", "Collection settings are invalid.");
    if (this.closing)
      return Promise.resolve(
        failure("UNAVAILABLE", "Session service is shutting down."),
      );
    return this.enqueue(async () => {
      const ready = await this.initializeInternal();
      if (!ready.ok) return ready;
      const result =
        this.getState().session?.status === "active"
          ? await this.transition("pause", this.epoch)
          : await this.stopWithoutTransition();
      if (!parsed.success)
        return failure("INVALID_INPUT", "Collection settings are invalid.");
      if (!result.ok && parsed.data.collectionConsent) return result;
      if (persist) {
        const saved = await this.operations.run(
          "Collection settings save",
          persist,
        );
        if (!saved.ok) {
          this.settingsOverride = {
            ...structuredClone(parsed.data),
            collectionConsent: false,
          };
          this.fail(saved.error.code, saved.error.message);
          this.requestCleanup();
          return saved;
        }
      }
      if (!result.ok) return result;
      this.settingsOverride = structuredClone(parsed.data);
      this.status = {
        collection: "off",
        unavailable: false,
        shutdown: false,
        error: null,
      };
      return result;
    }).finally(() => this.notify());
  }
  revokeConsent(): Promise<Result<SessionState>> {
    return this.updateSettings({
      ...(this.readSettings() ?? createDefaultSettings()),
      collectionConsent: false,
    });
  }

  shutdown(): Promise<Result<void>> {
    if (this.closed) return Promise.resolve(ok());
    if (this.shutdownAttempt) return this.shutdownAttempt;
    this.closing = true;
    this.invalidate();
    this.shutdownAttempt = this.enqueue(async () => {
      const stopped = await this.quiesce();
      if (!stopped.ok) return stopped;
      const session = this.getState().session;
      if (session && session.status !== "ended") {
        const ended = await this.transition("end", this.epoch);
        if (!ended.ok) return ended;
      }
      if (this.options.mode === "repository") {
        const storage = this.options.storage;
        const closed = await this.operations.run("Storage close", () =>
          storage.close(),
        );
        if (!closed.ok)
          return this.fail(closed.error.code, closed.error.message);
      }
      this.closed = true;
      this.status = {
        collection: "off",
        unavailable: false,
        shutdown: true,
        error: null,
      };
      return ok();
    }).finally(() => {
      this.shutdownAttempt = null;
      this.notify();
    });
    return this.shutdownAttempt;
  }

  private enqueue<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.commandCount >= maxCommands)
      return Promise.resolve(
        failure("UNAVAILABLE", "Session command queue is full."),
      );
    this.commandCount++;
    const result = this.commandTail.then(call).catch(() => {
      const failed = this.fail("UNAVAILABLE", "Session operation failed.");
      this.requestCleanup();
      return failed;
    });
    this.commandTail = result;
    return result.finally(() => {
      this.commandCount--;
    });
  }
  private invalidate(): void {
    this.epoch++;
    this.run = null;
    this.status.collection = "off";
    this.notify();
  }
  private notify(): void {
    try {
      this.options.onChanged?.();
    } catch {
      /* Observers cannot change a transition outcome. */
    }
  }
  private fail(
    code: AppError["code"],
    message: string,
  ): ReturnType<typeof failure> {
    this.invalidate();
    this.status = {
      collection: "unavailable",
      unavailable: true,
      shutdown: false,
      error: { code, message },
    };
    this.notify();
    return failure(code, message);
  }
  private readSettings(): UserSettings | null {
    try {
      const value =
        this.settingsOverride ??
        (this.options.mode === "repository"
          ? this.options.getSettings()
          : createDefaultSettings());
      const parsed = userSettingsSchema.safeParse(value);
      return parsed.success ? structuredClone(parsed.data) : null;
    } catch {
      return null;
    }
  }
  private requestCleanup(): void {
    if (this.cleanupPending || this.closing) return;
    this.cleanupPending = true;
    // One reserved cleanup task cannot be crowded out by the bounded client command queue.
    this.commandTail = this.commandTail
      .then(() => this.quiesce())
      .catch(() => this.fail("UNAVAILABLE", "Collector cleanup failed."))
      .finally(() => {
        this.cleanupPending = false;
      });
  }
  private async initializeInternal(): Promise<Result<void>> {
    if (this.initialized) return ok();
    if (this.options.mode === "session-only") {
      this.initialized = true;
      return ok();
    }
    const stopped = await this.quiesce();
    if (!stopped.ok) return stopped;
    const storage = this.options.storage;
    const opened = await this.operations.run("Storage open", () =>
      storage.open(),
    );
    if (!opened.ok) return this.fail(opened.error.code, opened.error.message);
    const repositories = storage.repositories;
    const latest = await this.operations.run("Session load", () =>
      repositories.sessions.getLatest(),
    );
    if (!latest.ok) return this.fail(latest.error.code, latest.error.message);
    if (latest.value !== null) {
      const parsed = sessionSchema.safeParse(latest.value);
      if (!parsed.success)
        return this.fail("INTEGRITY_FAILURE", "Stored session is invalid.");
      const session =
        parsed.data.status === "active"
          ? { ...parsed.data, status: "paused" as const }
          : parsed.data;
      if (parsed.data.status === "active") {
        const saved = await this.save(session);
        if (!saved.ok) return this.fail(saved.error.code, saved.error.message);
      }
      const restored = this.options.service.restore(session);
      if (!restored.ok)
        return this.fail(restored.error.code, restored.error.message);
    }
    this.initialized = true;
    this.status = {
      collection: "off",
      unavailable: false,
      shutdown: false,
      error: null,
    };
    return ok();
  }
  private async save(session: Session): Promise<Result<void>> {
    if (this.options.mode === "session-only") return ok();
    const repositories = this.options.storage.repositories;
    return this.operations.run("Session save", () =>
      repositories.sessions.save(structuredClone(session)),
    );
  }

  private async transition(
    action: Exclude<SessionAction, "get">,
    ticket: number,
  ): Promise<Result<SessionState>> {
    const before = this.getState().session;
    const planned = this.options.service.prepare(action);
    if (!planned.ok) return planned;
    const candidate = planned.value.state.session!;
    const activating = action === "start" || action === "resume";
    if (action === "start" && this.options.mode === "repository") {
      const sessions = this.options.storage.repositories.sessions;
      const existing = await this.operations.run("Session identity check", () =>
        sessions.get(candidate.id),
      );
      if (!existing.ok)
        return this.fail(existing.error.code, existing.error.message);
      if (existing.value !== null)
        return failure(
          "CONFLICT",
          "A new session requires an unused identity.",
        );
    }
    if (!activating) {
      const stopped = await this.quiesce();
      if (!stopped.ok) return stopped;
    }
    const saved = await this.save(candidate);
    if (!saved.ok)
      return activating
        ? this.compensate(before, candidate, saved)
        : this.fail(saved.error.code, saved.error.message);
    if (activating) {
      const settings = this.readSettings();
      if (!settings)
        return this.compensate(
          before,
          candidate,
          failure("FORBIDDEN", "Collection policy is unavailable."),
        );
      if (ticket !== this.epoch || this.closing)
        return this.compensate(
          before,
          candidate,
          failure("CONFLICT", "Transition superseded by a stop."),
        );
      if (this.options.mode === "repository" && settings.collectionConsent) {
        let generation: string;
        try {
          generation = (this.options.newGenerationId ?? randomUUID)();
        } catch {
          return this.compensate(
            before,
            candidate,
            failure(
              "UNAVAILABLE",
              "Collection generation could not be created.",
            ),
          );
        }
        if (!idSchema.safeParse(generation).success)
          return this.compensate(
            before,
            candidate,
            failure("INTEGRITY_FAILURE", "Collection generation is invalid."),
          );
        const run: Run = {
          id: generation,
          sessionId: candidate.id,
          settings,
          permissionKey: JSON.stringify(settings),
        };
        this.status.collection = "starting";
        for (const [source, collector] of Object.entries(
          this.options.collectors,
        )) {
          const started = await this.operations.run("Collector startup", () =>
            collector[action === "start" ? "start" : "resume"](
              this.context(run, source),
            ),
          );
          if (!started.ok) return this.compensate(before, candidate, started);
          if (
            ticket !== this.epoch ||
            this.closing ||
            JSON.stringify(this.readSettings()) !== run.permissionKey
          )
            return this.compensate(
              before,
              candidate,
              failure(
                "CONFLICT",
                "Collection authorization changed during startup.",
              ),
            );
        }
        const committed = planned.value.commit();
        if (!committed.ok) return this.compensate(before, candidate, committed);
        this.run = run;
        this.status = {
          collection: "active",
          unavailable: false,
          shutdown: false,
          error: null,
        };
        return committed;
      }
    }
    const committed = planned.value.commit();
    if (!committed.ok) return this.compensate(before, candidate, committed);
    this.status = {
      collection: "off",
      unavailable: false,
      shutdown: false,
      error: null,
    };
    return committed;
  }
  private async compensate(
    before: Session | null,
    candidate: Session,
    original: { ok: false; error: AppError },
  ): Promise<Result<SessionState>> {
    const stopped = await this.quiesce();
    if (!stopped.ok) return stopped;
    const rollback: Session =
      before?.id === candidate.id
        ? before
        : { ...candidate, status: "ended", endedAt: candidate.updatedAt };
    const saved = await this.save(rollback);
    if (!saved.ok)
      return this.fail(saved.error.code, "Session compensation failed.");
    this.status = {
      collection: "off",
      unavailable: false,
      shutdown: false,
      error: null,
    };
    return original;
  }
  private async stopCollectors(): Promise<Result<void>> {
    if (this.options.mode !== "repository") return ok();
    const results = await Promise.all(
      Object.values(this.options.collectors).map((collector) =>
        this.operations.run("Collector stop", () => collector.stop()),
      ),
    );
    return results.find((result) => !result.ok) ?? ok();
  }
  private async quiesce(): Promise<Result<void>> {
    this.run = null;
    this.status.collection = "stopping";
    const lateWork = this.operations.unsettled;
    const stopped = await this.stopCollectors();
    if (!stopped.ok)
      return this.fail(stopped.error.code, stopped.error.message);
    const drained = await this.operations.drain();
    if (!drained.ok)
      return this.fail(drained.error.code, drained.error.message);
    await this.ingestionTail;
    // A timed-out startup can settle after the first stop; stop it again before acknowledging.
    if (lateWork) {
      const restopped = await this.stopCollectors();
      if (!restopped.ok)
        return this.fail(restopped.error.code, restopped.error.message);
    }
    this.status.collection = "off";
    return ok();
  }
  private async stopWithoutTransition(): Promise<Result<SessionState>> {
    const stopped = await this.quiesce();
    return stopped.ok ? { ok: true, value: this.getState() } : stopped;
  }
  private context(run: Run, source: string): CollectorContext {
    return {
      sessionId: run.sessionId,
      generationId: run.id,
      settings: structuredClone(run.settings),
      emit: (events) => this.admit(run, source, events),
    };
  }
  private allowed(run: Run): boolean {
    const session = this.getState().session;
    const settings = this.readSettings();
    const permitted =
      settings?.collectionConsent === true &&
      JSON.stringify(settings) === run.permissionKey;
    if (
      this.run === run &&
      (!permitted ||
        session?.id !== run.sessionId ||
        session.status !== "active")
    ) {
      this.fail("FORBIDDEN", "Collection authority changed.");
      this.requestCleanup();
    }
    return (
      this.run === run && !this.closing && !this.status.unavailable && permitted
    );
  }
  private admit(
    run: Run,
    source: string,
    events: readonly ActivityEvent[],
  ): Promise<Result<void>> {
    if (!this.allowed(run))
      return Promise.resolve(
        failure("FORBIDDEN", "Collection generation is not authorized."),
      );
    if (!Array.isArray(events) || events.length > maxBatchEvents)
      return Promise.resolve(
        failure("INVALID_INPUT", "Activity batch capacity exceeded."),
      );
    if (this.batchCount >= maxBatches) {
      const result = this.fail(
        "UNAVAILABLE",
        "Activity queue capacity exceeded.",
      );
      this.requestCleanup();
      return Promise.resolve(result);
    }
    let parsed: ActivityEvent[];
    try {
      parsed = events.map((event) => activityEventSchema.parse(event));
      if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > maxBatchBytes)
        return Promise.resolve(
          failure("INVALID_INPUT", "Activity batch is too large."),
        );
    } catch {
      return Promise.resolve(
        failure("INVALID_INPUT", "Activity batch is invalid."),
      );
    }
    const expected =
      source === "windows"
        ? "windows"
        : source === "browser"
          ? "browser"
          : "filesystem";
    if (
      parsed.some(
        (event) =>
          event.sessionId !== run.sessionId ||
          (event.source !== expected &&
            !(source === "folders" && event.type === "file-opened")) ||
          (event.type === "browser-visit" &&
            event.payload.sessionId !== run.sessionId) ||
          event.occurredAt < this.getState().session!.startedAt,
      )
    )
      return Promise.resolve(
        failure(
          "FORBIDDEN",
          "Activity scope does not match the collection generation.",
        ),
      );
    this.batchCount++;
    const result = this.ingestionTail
      .then(() => this.ingest(run, parsed))
      .catch(() => {
        const failed = this.fail(
          "UNAVAILABLE",
          "Activity persistence is unavailable.",
        );
        this.requestCleanup();
        return failed;
      });
    this.ingestionTail = result.catch(() => undefined);
    return result.finally(() => {
      this.batchCount--;
    });
  }
  private async ingest(
    run: Run,
    events: ActivityEvent[],
  ): Promise<Result<void>> {
    if (this.options.mode !== "repository" || !this.allowed(run))
      return failure("FORBIDDEN", "Collection generation is not authorized.");
    const accepted: ActivityEvent[] = [];
    for (const event of events) {
      if (!this.allowed(run))
        return failure(
          "FORBIDDEN",
          "Collection permission changed during validation.",
        );
      if (isExcluded(event, run.settings)) continue;
      if (
        event.type === "browser-visit" ||
        event.type === "file-opened" ||
        event.type === "file-change"
      ) {
        if (
          event.type === "browser-visit" &&
          event.payload.articleText !== undefined &&
          !run.settings.articleExtractionEnabled
        )
          return failure(
            "FORBIDDEN",
            "Article extraction permission is unavailable.",
          );
        if (!this.options.authorizeResource)
          return failure("FORBIDDEN", "Resource authorization is unavailable.");
        const authorize = this.options.authorizeResource;
        const authorized = await this.operations.run(
          "Resource authorization",
          () => authorize(event, structuredClone(run.settings)),
        );
        if (!authorized.ok) return authorized;
      }
      accepted.push(event);
    }
    if (!this.allowed(run))
      return failure(
        "FORBIDDEN",
        "Collection permission changed before persistence.",
      );
    if (!accepted.length) return ok();
    const repositories = this.options.storage.repositories;
    const result = await this.operations.run("Activity append", () =>
      this.allowed(run)
        ? repositories.activities.append(accepted)
        : Promise.resolve(
            failure(
              "FORBIDDEN",
              "Collection permission changed before persistence.",
            ),
          ),
    );
    if (!result.ok || accepted.some((event) => event.type === "capture-gap")) {
      const error = result.ok
        ? {
            code: "UNAVAILABLE" as const,
            message: "A collector reported a capture gap.",
          }
        : result.error;
      this.fail(error.code, error.message);
      this.requestCleanup();
    }
    return result;
  }
}
