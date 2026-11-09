import { randomUUID } from "node:crypto";
import {
  failure,
  httpUrlSchema,
  type ActivityEvent,
  type Collector,
  type CollectorContext,
  type Result,
} from "@rewind/contracts";
import type { BrowserCollectorOptions, BrowserVisitInput } from "./types";

export class BrowserCollector implements Collector {
  readonly id = "browser";
  private readonly newId: () => string;
  private readonly now: () => string;

  private activeContext: CollectorContext | null = null;

  constructor(options: BrowserCollectorOptions = {}) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(context: CollectorContext): Promise<Result<void>> {
    this.activeContext = context;
    return { ok: true, value: undefined };
  }

  async pause(): Promise<Result<void>> {
    this.activeContext = null;
    return { ok: true, value: undefined };
  }

  async resume(context: CollectorContext): Promise<Result<void>> {
    this.activeContext = context;
    return { ok: true, value: undefined };
  }

  async stop(): Promise<Result<void>> {
    this.activeContext = null;
    return { ok: true, value: undefined };
  }

  async recordVisit(input: BrowserVisitInput): Promise<Result<void>> {
    if (!this.activeContext) {
      return failure(
        "INVALID_TRANSITION",
        "Cannot record browser visit: browser collector is not active.",
      );
    }

    if (!this.activeContext.settings.collectionConsent) {
      return failure(
        "FORBIDDEN",
        "Collection consent is not granted by user settings.",
      );
    }

    const currentContext = this.activeContext;
    const currentGenerationId = currentContext.generationId;

    // Validate URL against httpUrlSchema (HTTP/HTTPS, no credentials, <=8192 chars)
    const validUrl = httpUrlSchema.safeParse(input.url);
    if (!validUrl.success) {
      return failure(
        "INVALID_INPUT",
        `Invalid browser URL: ${validUrl.error.issues[0]?.message ?? "Must be HTTP(S) without credentials."}`,
      );
    }

    // Check site exclusions
    try {
      const parsedUrl = new URL(input.url);
      const hostname = parsedUrl.hostname.toLowerCase();
      const isExcluded = currentContext.settings.excludedSiteHosts.some(
        (excluded) => {
          const normEx = excluded.toLowerCase();
          return hostname === normEx || hostname.endsWith(`.${normEx}`);
        },
      );

      if (isExcluded) {
        return { ok: true, value: undefined }; // Silently ignored per privacy spec
      }
    } catch {
      return failure("INVALID_INPUT", "Malformed URL.");
    }

    const visitedAt = input.visitedAt ?? this.now();
    const visitId = this.newId();
    const cleanTitle = (input.title || "Untitled").trim().slice(0, 2048);

    // Only retain article extraction if explicitly enabled
    let articleText: string | undefined;
    if (currentContext.settings.articleExtractionEnabled && input.articleText) {
      articleText = input.articleText.slice(0, 100_000);
    }

    const event: ActivityEvent = {
      id: this.newId(),
      sessionId: currentContext.sessionId,
      occurredAt: visitedAt,
      source: "browser",
      type: "browser-visit",
      payload: {
        id: visitId,
        sessionId: currentContext.sessionId,
        browser: input.browser,
        url: input.url,
        title: cleanTitle,
        visitedAt,
        endedAt: input.endedAt ?? null,
        ...(articleText !== undefined ? { articleText } : {}),
      },
    };

    if (
      this.activeContext &&
      this.activeContext.generationId === currentGenerationId
    ) {
      return this.activeContext.emit([event]);
    }

    return failure("INVALID_TRANSITION", "Stale generation during visit emit.");
  }
}
