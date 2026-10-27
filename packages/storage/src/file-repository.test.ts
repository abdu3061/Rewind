import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import type { FileReference, FileVersion, Session } from "@rewind/contracts";
import { SqliteFileRepository } from "./file-repository";
import { SqliteSessionRepository } from "./session-repository";

describe("SqliteFileRepository", () => {
  let db: DatabaseSync;
  let sessionRepo: SqliteSessionRepository;
  let fileRepo: SqliteFileRepository;

  const validSessionId = "00000000-0000-4000-8000-000000000001";
  const fileId = "20000000-0000-4000-8000-000000000001";

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");

    // Run initial schema migration
    const migrationSql = readFileSync(
      resolve(__dirname, "../../../db/migrations/001_initial.sql"),
      "utf8",
    );
    db.exec(migrationSql);

    sessionRepo = new SqliteSessionRepository(db);
    fileRepo = new SqliteFileRepository(db);

    // Create a parent session
    const session: Session = {
      id: validSessionId,
      status: "active",
      startedAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      endedAt: null,
    };
    await sessionRepo.save(session);
  });

  it("saves and retrieves a verified-path file reference", async () => {
    const file: FileReference = {
      id: fileId,
      displayName: "report.docx",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\Users\\user\\Documents\\report.docx",
        verifiedAt: "2026-10-25T00:05:00.000Z",
      },
    };

    const saveResult = await fileRepo.saveReference(file);
    expect(saveResult.ok).toBe(true);

    const getResult = await fileRepo.getReference(fileId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toEqual(file);
    }
  });

  it("saves and retrieves an unverified file reference", async () => {
    const file: FileReference = {
      id: fileId,
      displayName: "notes.txt",
      identity: {
        kind: "unverified",
        observedTitle: "notes.txt - Notepad",
      },
    };

    await fileRepo.saveReference(file);

    const getResult = await fileRepo.getReference(fileId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toEqual(file);
    }
  });

  it("adds versions and lists them ordered newest first (capturedAt DESC)", async () => {
    // 1. Save the file first
    const file: FileReference = {
      id: fileId,
      displayName: "code.ts",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\project\\code.ts",
        verifiedAt: "2026-10-25T00:00:00.000Z",
      },
    };
    await fileRepo.saveReference(file);

    // 2. Add an older version (10:00 AM)
    const version1: FileVersion = {
      id: "30000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      fileId: fileId,
      capturedAt: "2026-10-25T10:00:00.000Z",
      contentHash: "a".repeat(64),
      byteLength: 1024,
      mediaType: "text/typescript",
    };

    // 3. Add a newer version (11:00 AM)
    const version2: FileVersion = {
      id: "30000000-0000-4000-8000-000000000002",
      sessionId: validSessionId,
      fileId: fileId,
      capturedAt: "2026-10-25T11:00:00.000Z",
      contentHash: "b".repeat(64),
      byteLength: 2048,
      mediaType: "text/typescript",
    };

    await fileRepo.addVersion(version1);
    await fileRepo.addVersion(version2);

    // 4. Retrieve single version
    const singleVersion = await fileRepo.getVersion(version1.id);
    expect(singleVersion.ok).toBe(true);
    if (singleVersion.ok) {
      expect(singleVersion.value).toEqual(version1);
    }

    // 5. List versions: version2 (11:00 AM) MUST come before version1 (10:00 AM)
    const listResult = await fileRepo.listVersions(fileId);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(2);
      expect(listResult.value[0]).toEqual(version2); // Newest first!
      expect(listResult.value[1]).toEqual(version1);
    }
  });
});
