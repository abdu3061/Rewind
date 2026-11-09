import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCollectorRegistry,
  MockWindowQueryStrategy,
} from "@rewind/collectors";
import type {
  FileReference,
  Repositories,
  UserSettings,
} from "@rewind/contracts";
import {
  SqliteActivityRepository,
  SqliteCheckpointRepository,
  SqliteFileRepository,
  SqliteSearchRepository,
  SqliteSessionRepository,
} from "@rewind/storage";
import { SessionCoordinator } from "./session-coordinator";
import { SessionService } from "./session-service";

describe("SessionCoordinator & Ingestion Integration", () => {
  let db: DatabaseSync;
  let repositories: Repositories;
  let windowStrategy: MockWindowQueryStrategy;
  let coordinator: SessionCoordinator;
  let userSettings: UserSettings;

  beforeEach(async () => {
    // 1. Create in-memory SQLite database and run migration schema
    db = new DatabaseSync(":memory:");
    const migrationSql = readFileSync(
      resolve(__dirname, "../../../db/migrations/001_initial.sql"),
      "utf8",
    );
    db.exec(migrationSql);

    repositories = {
      sessions: new SqliteSessionRepository(db),
      activities: new SqliteActivityRepository(db),
      files: new SqliteFileRepository(db),
      checkpoints: new SqliteCheckpointRepository(db),
      search: new SqliteSearchRepository(db),
    };

    windowStrategy = new MockWindowQueryStrategy({
      application: "Code.exe",
      windowTitle: "main.ts - Rewind",
    });

    let idCounter = 1;
    const nextId = () =>
      `00000000-0000-4000-8000-${String(idCounter++).padStart(12, "0")}`;

    const collectors = createCollectorRegistry({
      windowStrategy,
      windowPollIntervalMs: 50,
      newId: nextId,
      now: () => "2026-11-09T10:00:00.000Z",
    });

    userSettings = {
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

    const sessionService = new SessionService({
      newId: () => "00000000-0000-4000-8000-000000000001",
      now: () => "2026-11-09T10:00:00.000Z",
    });

    coordinator = new SessionCoordinator({
      service: sessionService,
      repositories,
      collectors,
      getSettings: () => userSettings,
      newGenerationId: () => "gen-1",
    });
  });

  it("coordinates start session, collects foreground activity, and persists into SQLite", async () => {
    // Start session
    const startResult = await coordinator.execute("start");
    expect(startResult.ok).toBe(true);

    const sessionId = "00000000-0000-4000-8000-000000000001";

    // Verify session persisted in SQLite
    const persistedSession = await repositories.sessions.get(sessionId);
    expect(persistedSession.ok).toBe(true);
    if (persistedSession.ok) {
      expect(persistedSession.value?.status).toBe("active");
    }

    // Verify timeline activity persisted in SQLite
    const activities = await repositories.activities.list(sessionId, 10);
    expect(activities.ok).toBe(true);
    if (activities.ok) {
      expect(activities.value.length).toBeGreaterThanOrEqual(1);
      expect(activities.value[0]?.type).toBe("foreground");
      expect(activities.value[0]?.payload).toEqual({
        application: "Code.exe",
        windowTitle: "main.ts - Rewind",
      });
    }

    await coordinator.execute("end");
  });

  it("persists browser visits and opened files during an active session", async () => {
    await coordinator.execute("start");
    const sessionId = "00000000-0000-4000-8000-000000000001";

    // 1. Record browser visit
    const visitResult = await coordinator.recordBrowserVisit({
      browser: "chrome",
      url: "https://rewind.ai/docs",
      title: "Rewind Documentation",
    });
    expect(visitResult.ok).toBe(true);

    // 2. Record opened file
    const fileRef: FileReference = {
      id: "20000000-0000-4000-8000-000000000001",
      displayName: "schema.sql",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\Rewind\\db\\schema.sql",
        verifiedAt: "2026-11-09T10:00:00.000Z",
      },
    };
    const fileResult = await coordinator.recordFileOpened(fileRef);
    expect(fileResult.ok).toBe(true);

    // Verify both activities are in SQLite
    const activities = await repositories.activities.list(sessionId, 10);
    expect(activities.ok).toBe(true);
    if (activities.ok) {
      const types = activities.value.map((a) => a.type);
      expect(types).toContain("browser-visit");
      expect(types).toContain("file-opened");
    }

    // Verify file reference was saved to files table
    const persistedFile = await repositories.files.getReference(fileRef.id);
    expect(persistedFile.ok).toBe(true);
    if (persistedFile.ok) {
      expect(persistedFile.value?.displayName).toBe("schema.sql");
    }

    await coordinator.execute("end");
  });

  it("respects pause and end states: stops recording and updates session in SQLite", async () => {
    await coordinator.execute("start");
    const sessionId = "00000000-0000-4000-8000-000000000001";

    // Pause
    const pauseResult = await coordinator.execute("pause");
    expect(pauseResult.ok).toBe(true);

    // Verify status updated in SQLite
    const pausedSession = await repositories.sessions.get(sessionId);
    expect(pausedSession.ok).toBe(true);
    if (pausedSession.ok) {
      expect(pausedSession.value?.status).toBe("paused");
    }

    // Attempting to record during paused state should fail / be rejected
    const visitWhilePaused = await coordinator.recordBrowserVisit({
      browser: "edge",
      url: "https://example.com",
      title: "Paused",
    });
    expect(visitWhilePaused.ok).toBe(false);

    // Resume
    const resumeResult = await coordinator.execute("resume");
    expect(resumeResult.ok).toBe(true);

    // End session
    const endResult = await coordinator.execute("end");
    expect(endResult.ok).toBe(true);

    const endedSession = await repositories.sessions.get(sessionId);
    expect(endedSession.ok).toBe(true);
    if (endedSession.ok) {
      expect(endedSession.value?.status).toBe("ended");
      expect(endedSession.value?.endedAt).toBeDefined();
    }
  });

  it("enforces privacy exclusions: excluded apps, sites, and folders are never persisted", async () => {
    userSettings.excludedApplications = ["secret-app"];
    userSettings.excludedSiteHosts = ["private.com"];
    userSettings.excludedFolderPaths = ["C:\\private"];

    await coordinator.execute("start");
    const sessionId = "00000000-0000-4000-8000-000000000001";

    // Switch to excluded app
    windowStrategy.setActiveWindow({
      application: "secret-app.exe",
      windowTitle: "Confidential",
    });

    // Record excluded site
    await coordinator.recordBrowserVisit({
      browser: "chrome",
      url: "https://private.com/docs",
      title: "Confidential Web",
    });

    // Record excluded folder
    await coordinator.recordFileOpened({
      id: "20000000-0000-4000-8000-000000000099",
      displayName: "secret.txt",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\private\\secret.txt",
        verifiedAt: "2026-11-09T10:00:00.000Z",
      },
    });

    // None of the excluded items should be in SQLite
    const activities = await repositories.activities.list(sessionId, 20);
    expect(activities.ok).toBe(true);
    if (activities.ok) {
      for (const act of activities.value) {
        if (act.type === "browser-visit") {
          expect(act.payload.url).not.toContain("private.com");
        }
        if (
          act.type === "file-opened" &&
          act.payload.identity.kind === "verified-path"
        ) {
          expect(act.payload.identity.absolutePath).not.toContain("private");
        }
      }
    }

    await coordinator.execute("end");
  });
});
