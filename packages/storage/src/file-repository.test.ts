import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
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

    const version1: FileVersion = {
      id: "30000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      fileId,
      capturedAt: "2026-10-25T10:00:00.000Z",
      contentHash: "a".repeat(64),
      byteLength: 1024,
      mediaType: "text/typescript",
    };

    const version2: FileVersion = {
      id: "30000000-0000-4000-8000-000000000002",
      sessionId: validSessionId,
      fileId,
      capturedAt: "2026-10-25T11:00:00.000Z",
      contentHash: "b".repeat(64),
      byteLength: 2048,
      mediaType: "text/typescript",
    };

    await fileRepo.addVersion(version1);
    await fileRepo.addVersion(version2);

    const singleVersion = await fileRepo.getVersion(version1.id);
    expect(singleVersion.ok).toBe(true);
    if (singleVersion.ok) {
      expect(singleVersion.value).toEqual(version1);
    }

    const listResult = await fileRepo.listVersions(fileId);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(2);
      expect(listResult.value[0]).toEqual(version2);
      expect(listResult.value[1]).toEqual(version1);
    }
  });

  it("queries the latest version of a file and versions by session", async () => {
    const file: FileReference = {
      id: fileId,
      displayName: "index.ts",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\src\\index.ts",
        verifiedAt: "2026-10-25T00:00:00.000Z",
      },
    };
    await fileRepo.saveReference(file);

    const versionOlder: FileVersion = {
      id: "30000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      fileId,
      capturedAt: "2026-10-25T10:00:00.000Z",
      contentHash: "1".repeat(64),
      byteLength: 500,
      mediaType: "text/typescript",
    };

    const versionNewer: FileVersion = {
      id: "30000000-0000-4000-8000-000000000002",
      sessionId: validSessionId,
      fileId,
      capturedAt: "2026-10-25T12:00:00.000Z",
      contentHash: "2".repeat(64),
      byteLength: 600,
      mediaType: "text/typescript",
    };

    await fileRepo.addVersion(versionOlder);
    await fileRepo.addVersion(versionNewer);

    // Latest version
    const latest = await fileRepo.getLatestVersion(fileId);
    expect(latest.ok).toBe(true);
    if (latest.ok) {
      expect(latest.value?.id).toBe(versionNewer.id);
    }

    // List by session
    const bySession = await fileRepo.listVersionsBySession(validSessionId);
    expect(bySession.ok).toBe(true);
    if (bySession.ok) {
      expect(bySession.value).toHaveLength(2);
      expect(bySession.value[0]?.id).toBe(versionNewer.id);
    }
  });

  it("finds versions by content hash for safe deduplication", async () => {
    const file: FileReference = {
      id: fileId,
      displayName: "doc.txt",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\doc.txt",
        verifiedAt: "2026-10-25T00:00:00.000Z",
      },
    };
    await fileRepo.saveReference(file);

    const targetHash = "c".repeat(64);
    const version: FileVersion = {
      id: "30000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      fileId,
      capturedAt: "2026-10-25T10:00:00.000Z",
      contentHash: targetHash,
      byteLength: 120,
      mediaType: "text/plain",
    };
    await fileRepo.addVersion(version);

    const found = await fileRepo.findVersionsByHash(targetHash);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value).toHaveLength(1);
      expect(found.value[0]?.id).toBe(version.id);
    }

    const notFound = await fileRepo.findVersionsByHash("d".repeat(64));
    expect(notFound.ok).toBe(true);
    if (notFound.ok) {
      expect(notFound.value).toHaveLength(0);
    }
  });

  it("enforces foreign key constraints and prevents version conflicts", async () => {
    const version: FileVersion = {
      id: "30000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      // File does not exist yet!
      fileId: "99999999-0000-4000-8000-000000000001",
      capturedAt: "2026-10-25T10:00:00.000Z",
      contentHash: "e".repeat(64),
      byteLength: 100,
      mediaType: "text/plain",
    };

    const missingFileResult = await fileRepo.addVersion(version);
    expect(missingFileResult.ok).toBe(false);
    if (!missingFileResult.ok) {
      expect(missingFileResult.error.code).toBe("NOT_FOUND");
    }

    // Now save file and add version
    const file: FileReference = {
      id: fileId,
      displayName: "app.ts",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\app.ts",
        verifiedAt: "2026-10-25T00:00:00.000Z",
      },
    };
    await fileRepo.saveReference(file);
    version.fileId = fileId;

    const addFirst = await fileRepo.addVersion(version);
    expect(addFirst.ok).toBe(true);

    // Conflict on duplicate version ID
    const addDuplicate = await fileRepo.addVersion(version);
    expect(addDuplicate.ok).toBe(false);
    if (!addDuplicate.ok) {
      expect(addDuplicate.error.code).toBe("CONFLICT");
    }
  });
});
