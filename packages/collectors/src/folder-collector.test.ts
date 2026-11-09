import { beforeEach, describe, expect, it } from "vitest";
import type {
  ActivityEvent,
  CollectorContext,
  FileReference,
  UserSettings,
} from "@rewind/contracts";
import { FolderCollector } from "./folder-collector";

describe("FolderCollector", () => {
  let collector: FolderCollector;
  let emittedEvents: ActivityEvent[];
  let baseSettings: UserSettings;
  let context: CollectorContext;

  const sessionId = "00000000-0000-4000-8000-000000000001";
  const generationId = "10000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    collector = new FolderCollector({
      debounceMs: 50,
      newId: () => "40000000-0000-4000-8000-000000000001",
      now: () => "2026-11-09T10:10:00.000Z",
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

  it("records opened files and emits file-opened activity events", async () => {
    await collector.start(context);

    const fileRef: FileReference = {
      id: "50000000-0000-4000-8000-000000000001",
      displayName: "app.ts",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\Users\\user\\project\\app.ts",
        verifiedAt: "2026-11-09T10:10:00.000Z",
      },
    };

    const result = await collector.recordFileOpened(fileRef);
    expect(result.ok).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      sessionId,
      source: "rewind",
      type: "file-opened",
      payload: fileRef,
    });

    await collector.stop();
  });

  it("records manual file changes and emits file-change activity events", async () => {
    await collector.start(context);

    const fileId = "50000000-0000-4000-8000-000000000001";
    const result = await collector.recordFileChange(fileId, "updated");

    expect(result.ok).toBe(true);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      sessionId,
      source: "filesystem",
      type: "file-change",
      payload: {
        fileId,
        change: "updated",
      },
    });

    await collector.stop();
  });

  it("filters out files located in excludedFolderPaths", async () => {
    baseSettings.excludedFolderPaths = ["C:\\Users\\user\\secret"];
    await collector.start(context);

    const secretFile: FileReference = {
      id: "50000000-0000-4000-8000-000000000002",
      displayName: "keys.json",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\Users\\user\\secret\\keys.json",
        verifiedAt: "2026-11-09T10:10:00.000Z",
      },
    };

    const result = await collector.recordFileOpened(secretFile);
    expect(result.ok).toBe(true);
    // Ignored due to exclusion
    expect(emittedEvents).toHaveLength(0);

    await collector.stop();
  });
});
