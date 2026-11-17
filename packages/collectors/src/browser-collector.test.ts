import { beforeEach, describe, expect, it } from "vitest";
import type {
  ActivityEvent,
  CollectorContext,
  UserSettings,
} from "@rewind/contracts";
import { BrowserCollector } from "./browser-collector";

describe("BrowserCollector", () => {
  let collector: BrowserCollector;
  let emittedEvents: ActivityEvent[];
  let baseSettings: UserSettings;
  let context: CollectorContext;

  const sessionId = "00000000-0000-4000-8000-000000000001";
  const generationId = "10000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    collector = new BrowserCollector({
      newId: () => "30000000-0000-4000-8000-000000000001",
      now: () => "2026-11-09T10:05:00.000Z",
    });

    emittedEvents = [];
    baseSettings = {
      collectionConsent: true,
      cloudAiEnabled: false,
      articleExtractionEnabled: false,
      retentionHours: 72,
      storageLimitBytes: 1024 * 1024 * 100,
      excludedApplications: [],
      excludedSiteHosts: [],
      excludedFolderPaths: [],
      protectedFolderIds: [],
    };

    context = {
      sessionId,
      generationId,
      settings: baseSettings,
      emit: async (events) => {
        emittedEvents.push(...events);
        return { ok: true, value: undefined };
      },
    };
  });

  it("records valid browser visits and emits browser-visit activity events", async () => {
    await collector.start(context);

    const result = await collector.recordVisit({
      browser: "chrome",
      url: "https://nodejs.org/docs/latest/api/",
      title: "Node.js v22 Documentation",
      visitedAt: "2026-11-09T10:05:00.000Z",
      endedAt: null,
    });

    expect(result.ok).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      sessionId,
      source: "browser",
      type: "browser-visit",
      payload: {
        browser: "chrome",
        url: "https://nodejs.org/docs/latest/api/",
        title: "Node.js v22 Documentation",
      },
    });

    await collector.stop();
  });

  it("rejects invalid URLs such as javascript: or file://", async () => {
    await collector.start(context);

    const badResult = await collector.recordVisit({
      browser: "edge",
      url: "file:///C:/passwords.txt",
      title: "File",
    });

    expect(badResult.ok).toBe(false);
    if (!badResult.ok) {
      expect(badResult.error.code).toBe("INVALID_INPUT");
    }
    expect(emittedEvents).toHaveLength(0);

    await collector.stop();
  });

  it("filters out excluded site hosts based on user settings", async () => {
    baseSettings.excludedSiteHosts = ["bank.com", "internal.corp"];
    await collector.start(context);

    const excludedResult = await collector.recordVisit({
      browser: "chrome",
      url: "https://secure.bank.com/account",
      title: "Online Banking",
    });

    expect(excludedResult.ok).toBe(true);
    // Dropped silently due to privacy exclusion
    expect(emittedEvents).toHaveLength(0);

    // Allowed visit
    await collector.recordVisit({
      browser: "chrome",
      url: "https://github.com/rewind",
      title: "Rewind Repo",
    });
    expect(emittedEvents).toHaveLength(1);

    await collector.stop();
  });

  it("strips articleText unless articleExtractionEnabled is true", async () => {
    baseSettings.articleExtractionEnabled = false;
    await collector.start(context);

    await collector.recordVisit({
      browser: "chrome",
      url: "https://example.com/article",
      title: "An Article",
      articleText: "Extracted article body...",
    });

    expect(emittedEvents[0]?.payload).toBeDefined();
    if (emittedEvents[0]?.type === "browser-visit") {
      expect(emittedEvents[0].payload.articleText).toBeUndefined();
    }

    // Now enable article extraction
    baseSettings.articleExtractionEnabled = true;
    await collector.recordVisit({
      browser: "chrome",
      url: "https://example.com/article2",
      title: "Another Article",
      articleText: "Permitted article body text",
    });

    if (emittedEvents[1]?.type === "browser-visit") {
      expect(emittedEvents[1].payload.articleText).toBe(
        "Permitted article body text",
      );
    }

    await collector.stop();
  });
});
