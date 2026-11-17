import { randomUUID } from "node:crypto";
import {
  activityEventSchema,
  failure,
  type ActivityEvent,
  type BrowserVisitInput,
  type CollectorContext,
  type CollectorRegistry,
  type FileReference,
  type Id,
  type Repositories,
  type Result,
  type SessionAction,
  type SessionState,
  type UserSettings,
} from "@rewind/contracts";
import type { SessionService } from "./session-service";

export interface SessionCoordinatorOptions {
  service: SessionService;
  repositories: Repositories;
  collectors: CollectorRegistry;
  getSettings: () => UserSettings;
  newGenerationId?: () => string;
}

export class SessionCoordinator {
  private readonly service: SessionService;
  private readonly repositories: Repositories;
  private readonly collectors: CollectorRegistry;
  private readonly getSettings: () => UserSettings;
  private readonly newGenerationId: () => string;

  private currentGenerationId: string | null = null;

  constructor(options: SessionCoordinatorOptions) {
    this.service = options.service;
    this.repositories = options.repositories;
    this.collectors = options.collectors;
    this.getSettings = options.getSettings;
    this.newGenerationId = options.newGenerationId ?? randomUUID;
  }

  getState(): SessionState {
    return this.service.getState();
  }

  getActiveGenerationId(): string | null {
    return this.currentGenerationId;
  }

  async recordBrowserVisit(input: BrowserVisitInput): Promise<Result<void>> {
    const browserCol = this.collectors.browser as unknown as Record<
      string,
      unknown
    >;
    if (typeof browserCol.recordVisit === "function") {
      return (
        browserCol as {
          recordVisit: (i: BrowserVisitInput) => Promise<Result<void>>;
        }
      ).recordVisit(input);
    }
    return failure(
      "NOT_IMPLEMENTED",
      "Browser collector does not support recordVisit.",
    );
  }

  async recordFileOpened(file: FileReference): Promise<Result<void>> {
    const foldersCol = this.collectors.folders as unknown as Record<
      string,
      unknown
    >;
    if (typeof foldersCol.recordFileOpened === "function") {
      return (
        foldersCol as {
          recordFileOpened: (f: FileReference) => Promise<Result<void>>;
        }
      ).recordFileOpened(file);
    }
    return failure(
      "NOT_IMPLEMENTED",
      "Folder collector does not support recordFileOpened.",
    );
  }

  async recordFileChange(
    fileId: Id,
    change: "created" | "updated" | "deleted" | "renamed",
  ): Promise<Result<void>> {
    const foldersCol = this.collectors.folders as unknown as Record<
      string,
      unknown
    >;
    if (typeof foldersCol.recordFileChange === "function") {
      return (
        foldersCol as {
          recordFileChange: (
            id: Id,
            c: "created" | "updated" | "deleted" | "renamed",
          ) => Promise<Result<void>>;
        }
      ).recordFileChange(fileId, change);
    }
    return failure(
      "NOT_IMPLEMENTED",
      "Folder collector does not support recordFileChange.",
    );
  }

  async execute(action: SessionAction): Promise<Result<SessionState>> {
    const result = this.service.execute(action);
    if (!result.ok) {
      return result;
    }

    const state = result.value;
    const session = state.session;
    const settings = this.getSettings();

    if (action === "start" && session) {
      // 1. Persist session into SQLite
      await this.repositories.sessions.save(session);

      // 2. Start collectors only if consent is granted
      if (settings.collectionConsent) {
        this.currentGenerationId = this.newGenerationId();
        const context = this.createCollectorContext(
          session.id,
          this.currentGenerationId,
          settings,
        );

        await Promise.all([
          this.collectors.windows.start(context),
          this.collectors.browser.start(context),
          this.collectors.folders.start(context),
        ]);
      } else {
        this.currentGenerationId = null;
      }
    } else if (action === "pause" && session) {
      // Invalidate current generation so stale queued events are rejected
      this.currentGenerationId = null;

      await Promise.all([
        this.collectors.windows.pause(),
        this.collectors.browser.pause(),
        this.collectors.folders.pause(),
      ]);

      await this.repositories.sessions.save(session);
    } else if (action === "resume" && session) {
      await this.repositories.sessions.save(session);

      if (settings.collectionConsent) {
        this.currentGenerationId = this.newGenerationId();
        const context = this.createCollectorContext(
          session.id,
          this.currentGenerationId,
          settings,
        );

        await Promise.all([
          this.collectors.windows.resume(context),
          this.collectors.browser.resume(context),
          this.collectors.folders.resume(context),
        ]);
      } else {
        this.currentGenerationId = null;
      }
    } else if (action === "end" && session) {
      this.currentGenerationId = null;

      await Promise.all([
        this.collectors.windows.stop(),
        this.collectors.browser.stop(),
        this.collectors.folders.stop(),
      ]);

      await this.repositories.sessions.save(session);
    }

    return { ok: true, value: state };
  }

  private createCollectorContext(
    sessionId: Id,
    generationId: Id,
    settings: UserSettings,
  ): CollectorContext {
    return {
      sessionId,
      generationId,
      settings,
      emit: async (events: readonly ActivityEvent[]): Promise<Result<void>> => {
        return this.handleEmittedEvents(generationId, sessionId, events);
      },
    };
  }

  private async handleEmittedEvents(
    generationId: string,
    sessionId: string,
    events: readonly ActivityEvent[],
  ): Promise<Result<void>> {
    // 1. Reject stale queued events
    if (this.currentGenerationId !== generationId) {
      return failure(
        "INVALID_TRANSITION",
        "Stale generation: event emission rejected.",
      );
    }

    const currentState = this.service.getState();
    if (currentState.session?.status !== "active") {
      return failure(
        "INVALID_TRANSITION",
        "Session is not active: event emission rejected.",
      );
    }

    const settings = this.getSettings();
    if (!settings.collectionConsent) {
      return failure(
        "FORBIDDEN",
        "Collection consent not granted: event emission rejected.",
      );
    }

    // 2. Filter exclusions and validate each event
    const validEvents: ActivityEvent[] = [];

    for (const event of events) {
      // Must belong to current session
      if (event.sessionId !== sessionId) continue;

      const parsed = activityEventSchema.safeParse(event);
      if (!parsed.success) continue;

      // Filter foreground application exclusions
      if (event.type === "foreground") {
        const appName = event.payload.application
          .toLowerCase()
          .replace(/\.exe$/, "");
        const isExcluded = settings.excludedApplications.some(
          (ex) => ex.toLowerCase().replace(/\.exe$/, "") === appName,
        );
        if (isExcluded) continue;
      }

      // Filter browser visit exclusions
      if (event.type === "browser-visit") {
        try {
          const urlObj = new URL(event.payload.url);
          const hostname = urlObj.hostname.toLowerCase();
          const isExcluded = settings.excludedSiteHosts.some((ex) => {
            const normEx = ex.toLowerCase();
            return hostname === normEx || hostname.endsWith(`.${normEx}`);
          });
          if (isExcluded) continue;
        } catch {
          continue;
        }
      }

      // Filter opened file exclusions
      if (
        event.type === "file-opened" &&
        event.payload.identity.kind === "verified-path"
      ) {
        const filePath = event.payload.identity.absolutePath.toLowerCase();
        const isExcluded = settings.excludedFolderPaths.some((ex) =>
          filePath.startsWith(ex.toLowerCase()),
        );
        if (isExcluded) continue;
      }

      validEvents.push(event);
    }

    if (validEvents.length === 0) {
      return { ok: true, value: undefined };
    }

    // 3. Persist activities into SQLite
    const appendResult = await this.repositories.activities.append(validEvents);
    if (!appendResult.ok) {
      return appendResult;
    }

    // 4. Persist any referenced files into files table
    for (const event of validEvents) {
      if (event.type === "file-opened") {
        await this.repositories.files.saveReference(event.payload);
      }
    }

    return { ok: true, value: undefined };
  }
}
