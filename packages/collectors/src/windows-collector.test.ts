import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityEvent,
  CollectorContext,
  UserSettings,
} from "@rewind/contracts";
import {
  MockWindowQueryStrategy,
  WindowsWindowQueryStrategy,
} from "./window-strategy";
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

  it("safely catches OS script and strategy errors, logs a warning, and avoids throwing", async () => {
    const errorStrategy: MockWindowQueryStrategy = {
      queryCount: 0,
      setActiveWindow: () => {},
      getActiveWindow: async () => {
        throw new Error(
          "PowerShell process exited with code 1: no desktop window",
        );
      },
    } as unknown as MockWindowQueryStrategy;

    const errorCollector = new WindowsCollector({
      strategy: errorStrategy,
      pollIntervalMs: 50,
      newId: () => "20000000-0000-4000-8000-000000000001",
      now: () => "2026-11-09T10:00:00.000Z",
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Starting with a failing strategy must not crash or reject
    const startResult = await errorCollector.start(context);
    expect(startResult.ok).toBe(true);

    // Polling directly must not throw
    await expect(errorCollector.poll()).resolves.toBeUndefined();
    expect(emittedEvents).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[WindowsCollector] Strategy getActiveWindow threw an error:",
      expect.stringContaining("PowerShell process exited with code 1"),
    );

    await errorCollector.stop();
    warnSpy.mockRestore();
  });

  it("handles null fallback cleanly when no active window is found in headless environments", async () => {
    strategy.setActiveWindow(null);
    await collector.start(context);
    expect(emittedEvents).toHaveLength(0);

    await collector.poll();
    expect(emittedEvents).toHaveLength(0);

    await collector.stop();
  });

  it("WindowsWindowQueryStrategy handles OS script errors gracefully and returns fallback null", async () => {
    const queryStrategy = new WindowsWindowQueryStrategy();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // In environments without powershell or with failing scripts, must return null and never throw
    const result = await queryStrategy.getActiveWindow();
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
