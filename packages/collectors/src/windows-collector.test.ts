import { beforeEach, describe, expect, it } from "vitest";
import type {
  ActivityEvent,
  CollectorContext,
  UserSettings,
} from "@rewind/contracts";
import { MockWindowQueryStrategy } from "./window-strategy";
import { WindowsCollector } from "./windows-collector";

describe("WindowsCollector", () => {
  let strategy: MockWindowQueryStrategy;
  let collector: WindowsCollector;
  let emittedEvents: ActivityEvent[];
  let baseSettings: UserSettings;
  let context: CollectorContext;

  const sessionId = "00000000-0000-4000-8000-000000000001";
  const generationId = "10000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    strategy = new MockWindowQueryStrategy({
      application: "Code.exe",
      windowTitle: "session-coordinator.ts - Rewind",
    });

    collector = new WindowsCollector({
      strategy,
      pollIntervalMs: 50,
      newId: () => "20000000-0000-4000-8000-000000000001",
      now: () => "2026-11-09T10:00:00.000Z",
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

  it("captures active window applications and emits foreground events", async () => {
    await collector.start(context);

    // Initial poll occurs immediately on start
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      sessionId,
      source: "windows",
      type: "foreground",
      payload: {
        application: "Code.exe",
        windowTitle: "session-coordinator.ts - Rewind",
      },
    });

    await collector.stop();
  });

  it("filters out applications in excludedApplications setting", async () => {
    baseSettings.excludedApplications = ["KeePass.exe", "1password"];
    strategy.setActiveWindow({
      application: "keepass.exe",
      windowTitle: "Master Key Vault",
    });

    await collector.start(context);
    expect(emittedEvents).toHaveLength(0);

    // Switch to unexcluded app
    strategy.setActiveWindow({
      application: "terminal",
      windowTitle: "bash",
    });
    await collector.poll();

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]?.payload).toMatchObject({
      application: "terminal",
      windowTitle: "bash",
    });

    await collector.stop();
  });

  it("deduplicates consecutive identical window observations", async () => {
    await collector.start(context);
    expect(emittedEvents).toHaveLength(1);

    // Poll again with same active window
    await collector.poll();
    expect(emittedEvents).toHaveLength(1); // No duplicate emitted

    // Switch window
    strategy.setActiveWindow({
      application: "chrome.exe",
      windowTitle: "GitHub PR #3",
    });
    await collector.poll();

    expect(emittedEvents).toHaveLength(2);
    expect(emittedEvents[1]?.payload).toMatchObject({
      application: "chrome.exe",
      windowTitle: "GitHub PR #3",
    });

    await collector.stop();
  });

  it("respects lifecycle states: pauses, resumes, and stops", async () => {
    await collector.start(context);
    expect(emittedEvents).toHaveLength(1);

    await collector.pause();
    strategy.setActiveWindow({
      application: "slack.exe",
      windowTitle: "general",
    });
    await collector.poll();
    // No events should be emitted while paused
    expect(emittedEvents).toHaveLength(1);

    // Resume with fresh context
    const freshContext: CollectorContext = {
      ...context,
      generationId: "10000000-0000-4000-8000-000000000002",
    };
    await collector.resume(freshContext);
    expect(emittedEvents).toHaveLength(2);
    expect(emittedEvents[1]?.payload).toMatchObject({
      application: "slack.exe",
    });

    await collector.stop();
  });

  it("does not emit events when collectionConsent is false", async () => {
    baseSettings.collectionConsent = false;
    await collector.start(context);
    expect(emittedEvents).toHaveLength(0);

    await collector.poll();
    expect(emittedEvents).toHaveLength(0);

    await collector.stop();
  });
});
