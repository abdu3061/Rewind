import { randomUUID } from "node:crypto";
import type {
  ActivityEvent,
  Collector,
  CollectorContext,
  Result,
} from "@rewind/contracts";
import type { WindowQueryStrategy, WindowsCollectorOptions } from "./types";
import { createDefaultWindowQueryStrategy } from "./window-strategy";

export class WindowsCollector implements Collector {
  readonly id = "windows";
  private readonly strategy: WindowQueryStrategy;
  private readonly pollIntervalMs: number;
  private readonly newId: () => string;
  private readonly now: () => string;

  private activeContext: CollectorContext | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastApplication: string | null = null;
  private lastWindowTitle: string | null = null;
  private isPolling = false;

  constructor(options: WindowsCollectorOptions = {}) {
    this.strategy = options.strategy ?? createDefaultWindowQueryStrategy();
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(context: CollectorContext): Promise<Result<void>> {
    this.clearTimer();
    this.activeContext = context;
    this.lastApplication = null;
    this.lastWindowTitle = null;

    if (context.settings.collectionConsent) {
      this.timer = setInterval(() => {
        void this.poll();
      }, this.pollIntervalMs);
      void this.poll();
    }

    return { ok: true, value: undefined };
  }

  async pause(): Promise<Result<void>> {
    this.clearTimer();
    this.activeContext = null;
    return { ok: true, value: undefined };
  }

  async resume(context: CollectorContext): Promise<Result<void>> {
    this.clearTimer();
    this.activeContext = context;

    if (context.settings.collectionConsent) {
      this.timer = setInterval(() => {
        void this.poll();
      }, this.pollIntervalMs);
      void this.poll();
    }

    return { ok: true, value: undefined };
  }

  async stop(): Promise<Result<void>> {
    this.clearTimer();
    this.activeContext = null;
    this.lastApplication = null;
    this.lastWindowTitle = null;
    return { ok: true, value: undefined };
  }

  async poll(): Promise<void> {
    if (this.isPolling || !this.activeContext) return;
    if (!this.activeContext.settings.collectionConsent) return;

    this.isPolling = true;
    const currentContext = this.activeContext;
    const currentGenerationId = currentContext.generationId;

    try {
      const windowInfo = await this.strategy.getActiveWindow();
      if (!windowInfo) return;

      // Ensure context or generation hasn't changed during async call
      if (
        !this.activeContext ||
        this.activeContext.generationId !== currentGenerationId
      ) {
        return;
      }

      const appName = windowInfo.application.trim();
      const title = windowInfo.windowTitle.trim();

      // Check application exclusions (case-insensitive)
      const isExcluded = currentContext.settings.excludedApplications.some(
        (excluded) => {
          const normEx = excluded.toLowerCase().replace(/\.exe$/, "");
          const normApp = appName.toLowerCase().replace(/\.exe$/, "");
          return normEx === normApp;
        },
      );

      if (isExcluded) {
        this.lastApplication = appName;
        this.lastWindowTitle = title;
        return;
      }

      // Deduplicate consecutive identical observations
      if (this.lastApplication === appName && this.lastWindowTitle === title) {
        return;
      }

      this.lastApplication = appName;
      this.lastWindowTitle = title;

      const event: ActivityEvent = {
        id: this.newId(),
        sessionId: currentContext.sessionId,
        occurredAt: this.now(),
        source: "windows",
        type: "foreground",
        payload: {
          application: (appName || "unknown").slice(0, 255),
          windowTitle: title.slice(0, 2048),
        },
      };

      if (
        this.activeContext &&
        this.activeContext.generationId === currentGenerationId
      ) {
        await this.activeContext.emit([event]);
      }
    } catch {
      // Safe fallback - monitoring never crashes the process
    } finally {
      this.isPolling = false;
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
