import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ActivityEvent,
  Checkpoint,
  FileReference,
  Session,
} from "@rewind/contracts";
import { SqliteActivityRepository } from "./activity-repository";
import { SqliteCheckpointRepository } from "./checkpoint-repository";
import { SqliteFileRepository } from "./file-repository";
import { SqliteSearchRepository } from "./search-repository";
import { SqliteSessionRepository } from "./session-repository";

describe("SqliteSearchRepository", () => {
  let db: DatabaseSync;
  let sessionRepo: SqliteSessionRepository;
  let activityRepo: SqliteActivityRepository;
  let fileRepo: SqliteFileRepository;
  let checkpointRepo: SqliteCheckpointRepository;
  let searchRepo: SqliteSearchRepository;

  const validSessionId = "00000000-0000-4000-8000-000000000001";

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");

    const migrationSql = readFileSync(
      resolve(__dirname, "../../../db/migrations/001_initial.sql"),
      "utf8",
    );
    db.exec(migrationSql);

    sessionRepo = new SqliteSessionRepository(db);
    activityRepo = new SqliteActivityRepository(db);
    fileRepo = new SqliteFileRepository(db);
    checkpointRepo = new SqliteCheckpointRepository(db);
    searchRepo = new SqliteSearchRepository(db);

    const session: Session = {
      id: validSessionId,
      status: "active",
      startedAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      endedAt: null,
    };
    await sessionRepo.save(session);
  });

  it("finds activities, files, and checkpoints matching search keywords", async () => {
    // 1. Add an activity
    const event: ActivityEvent = {
      id: "10000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      source: "windows",
      type: "foreground",
      occurredAt: "2026-10-25T00:05:00.000Z",
      payload: {
        application: "chrome.exe",
        windowTitle: "GitHub - Rewind Project Database",
      },
    };
    await activityRepo.append([event]);

    // 2. Add a file
    const file: FileReference = {
      id: "20000000-0000-4000-8000-000000000001",
      displayName: "database-design.pdf",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\docs\\database-design.pdf",
        verifiedAt: "2026-10-25T00:10:00.000Z",
      },
    };
    await fileRepo.saveReference(file);

    // 3. Add a checkpoint
    const checkpoint: Checkpoint = {
      id: "40000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      name: "Completed Database Milestones",
      createdAt: "2026-10-25T00:15:00.000Z",
      kept: true,
      fileVersionIds: [],
      browserVisitIds: [],
      projectReferences: [],
    };
    await checkpointRepo.save(checkpoint);

    // Search for "Database"
    const searchResult = await searchRepo.search({
      text: "Database",
      mode: "keyword",
      limit: 10,
    });

    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value.length).toBe(3);

      const kinds = searchResult.value.map((r) => r.source.kind);
      expect(kinds).toContain("activity");
      expect(kinds).toContain("file-version");
      expect(kinds).toContain("checkpoint");
    }
  });

  it("returns browser-visit source kind when an activity is a browser visit", async () => {
    const browserVisitId = "30000000-0000-4000-8000-000000000001";
    const event: ActivityEvent = {
      id: "10000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      source: "browser",
      type: "browser-visit",
      occurredAt: "2026-10-25T00:05:00.000Z",
      payload: {
        id: browserVisitId,
        sessionId: validSessionId,
        browser: "chrome",
        url: "https://sqlite.org/docs",
        title: "SQLite Documentation and Guides",
        visitedAt: "2026-10-25T00:05:00.000Z",
        endedAt: null,
      },
    };
    await activityRepo.append([event]);

    const searchResult = await searchRepo.search({
      text: "SQLite",
      mode: "keyword",
      limit: 5,
    });

    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value).toHaveLength(1);
      expect(searchResult.value[0]?.source.kind).toBe("browser-visit");
      if (searchResult.value[0]?.source.kind === "browser-visit") {
        expect(searchResult.value[0].source.browserVisitId).toBe(
          browserVisitId,
        );
      }
    }
  });

  it("filters search results by time range and limit", async () => {
    const event1: ActivityEvent = {
      id: "10000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      source: "windows",
      type: "foreground",
      occurredAt: "2026-10-25T01:00:00.000Z",
      payload: { application: "Code.exe", windowTitle: "matching-search" },
    };
    const event2: ActivityEvent = {
      id: "10000000-0000-4000-8000-000000000002",
      sessionId: validSessionId,
      source: "windows",
      type: "foreground",
      occurredAt: "2026-10-25T05:00:00.000Z",
      payload: { application: "Code.exe", windowTitle: "matching-search" },
    };
    await activityRepo.append([event1, event2]);

    const filtered = await searchRepo.search({
      text: "matching-search",
      mode: "keyword",
      from: "2026-10-25T02:00:00.000Z",
      to: "2026-10-25T06:00:00.000Z",
      limit: 10,
    });

    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.value).toHaveLength(1);
      expect(filtered.value[0]?.occurredAt).toBe("2026-10-25T05:00:00.000Z");
    }
  });

  it("returns empty array when no matches are found", async () => {
    const searchResult = await searchRepo.search({
      text: "NonExistentKeywordXYZ",
      mode: "keyword",
      limit: 10,
    });

    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value).toHaveLength(0);
    }
  });

  it("rejects invalid search queries with INVALID_INPUT error", async () => {
    // limit exceeds max 100
    const invalidResult = await searchRepo.search({
      text: "test",
      mode: "keyword",
      limit: 500,
    });
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) {
      expect(invalidResult.error.code).toBe("INVALID_INPUT");
    }
  });
});
