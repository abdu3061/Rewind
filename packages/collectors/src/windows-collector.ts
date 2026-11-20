import { randomUUID } from "node:crypto";
import {
  activityEventSchema,
  failure,
  idSchema,
  userSettingsSchema,
  type Collector,
  type CollectorContext,
  type Result,
} from "@rewind/contracts";
import type {
  ActiveWindowInfo,
  WindowQueryStrategy,
  WindowsCollectorOptions,
} from "./types";
import { createDefaultWindowQueryStrategy } from "./window-strategy";

const ok = (): Result<void> => ({ ok: true, value: undefined });

/** PR #5's polling adapter, with serialized lifecycle and acknowledged query/emit shutdown. */
export class WindowsCollector implements Collector {
  readonly id = "windows";
  private readonly strategy: WindowQueryStrategy;
  private readonly pollIntervalMs: number;
  private readonly newId: () => string;
  private readonly now: () => string;
  private activeContext: CollectorContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<Result<void>> | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private lastAccepted: string | null = null;

  constructor(options: WindowsCollectorOptions = {}) {
    this.strategy = options.strategy ?? createDefaultWindowQueryStrategy();
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    if (
      !Number.isFinite(this.pollIntervalMs) ||
      this.pollIntervalMs < 10 ||
      this.pollIntervalMs > 60000
    )
      throw new Error("A bounded polling interval is required.");
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }
  start(context: CollectorContext): Promise<Result<void>> {
    this.invalidate();
    const ticket = this.epoch;
    const settings = userSettingsSchema.safeParse(context.settings);
    return this.enqueue(async () => {
      await this.polling;
      if (ticket !== this.epoch)
        return failure("CONFLICT", "Collector startup was superseded.");
      if (
        !settings.success ||
        !settings.data.collectionConsent ||
        !idSchema.safeParse(context.sessionId).success ||
        !idSchema.safeParse(context.generationId).success
      )
        return failure(
          "FORBIDDEN",
          "Collection requires valid explicit consent and session authority.",
        );
      // Establish adapter readiness, but do not emit before the coordinator's commit point.
      try {
        await this.queryWindow(settings.data.excludedApplications);
      } catch {
        try {
          await this.strategy.close?.();
        } catch {
          /* Keep the lifecycle unavailable. */
        }
        return failure("UNAVAILABLE", "Window query is unavailable.");
      }
      if (ticket !== this.epoch)
        return failure("CONFLICT", "Collector startup was superseded.");
      this.activeContext = {
        ...context,
        settings: structuredClone(settings.data),
      };
      this.lastAccepted = null;
      this.timer = setInterval(() => {
        void this.poll();
      }, this.pollIntervalMs);
      return ok();
    });
  }
  resume(context: CollectorContext): Promise<Result<void>> {
    return this.start(context);
  }
  pause(): Promise<Result<void>> {
    return this.stop();
  }
  stop(): Promise<Result<void>> {
    this.invalidate();
    return this.enqueue(async () => {
      await this.polling;
      await this.strategy.close?.();
      return ok();
    });
  }
  private invalidate(): void {
    this.epoch++;
    this.activeContext = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastAccepted = null;
  }
  private enqueue(call: () => Promise<Result<void>>): Promise<Result<void>> {
    const result = this.lifecycle
      .then(call)
      .catch(() => failure("UNAVAILABLE", "Collector lifecycle failed."));
    this.lifecycle = result;
    return result;
  }
  private async queryWindow(
    exclusions: readonly string[],
  ): Promise<ActiveWindowInfo | null> {
    const info = await this.strategy.getActiveWindow(exclusions);
    if (
      info !== null &&
      (!info ||
        typeof info.application !== "string" ||
        typeof info.windowTitle !== "string")
    )
      throw new Error("WINDOW_OBSERVATION_INVALID");
    return info;
  }
  poll(): Promise<Result<void>> {
    if (this.polling) return this.polling;
    const context = this.activeContext;
    if (!context)
      return Promise.resolve(
        failure("INVALID_TRANSITION", "Window collector is stopped."),
      );
    this.polling = this.pollWindow(context)
      .catch(() => failure("UNAVAILABLE", "Window observation failed."))
      .finally(() => {
        this.polling = null;
      });
    return this.polling;
  }
  private async pollWindow(context: CollectorContext): Promise<Result<void>> {
    if (context !== this.activeContext)
      return failure("FORBIDDEN", "Collection generation changed.");
    let info;
    try {
      info = await this.queryWindow(context.settings.excludedApplications);
    } catch {
      if (context === this.activeContext) {
        const reported = await context.emit([
          {
            id: this.newId(),
            sessionId: context.sessionId,
            occurredAt: this.now(),
            source: "windows",
            type: "capture-gap",
            payload: { collectorId: this.id, reason: "unavailable" },
          },
        ]);
        if (!reported.ok) return reported;
      }
      return failure("UNAVAILABLE", "Window query is unavailable.");
    }
    if (context !== this.activeContext)
      return failure("FORBIDDEN", "Collection generation changed.");
    if (!info) return ok();
    const application = info.application.trim().slice(0, 255) || "unknown";
    const windowTitle = info.windowTitle.trim().slice(0, 2048);
    const normalized = application.toLowerCase().replace(/\.exe$/, "");
    if (
      ["chrome", "msedge", "firefox", "brave", "opera", "rewind"].includes(
        normalized,
      ) ||
      context.settings.excludedApplications.some(
        (item) => item.toLowerCase().replace(/\.exe$/, "") === normalized,
      )
    )
      return ok();
    const key = JSON.stringify([application, windowTitle]);
    if (key === this.lastAccepted) return ok();
    const parsed = activityEventSchema.safeParse({
      id: this.newId(),
      sessionId: context.sessionId,
      occurredAt: this.now(),
      source: "windows",
      type: "foreground",
      payload: { application, windowTitle },
    });
    if (!parsed.success)
      return failure("INVALID_INPUT", "Window observation is invalid.");
    const result = await context.emit([parsed.data]);
    if (result.ok && context === this.activeContext) this.lastAccepted = key;
    return result;
  }
}
