import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  Checkpoint,
  FileReference,
  FileVersion,
  Session,
} from "@rewind/contracts";
import { SqliteCheckpointRepository } from "./checkpoint-repository";
import { SqliteFileRepository } from "./file-repository";
import { SqliteSessionRepository } from "./session-repository";

describe("SqliteCheckpointRepository", () => {
  let db: DatabaseSync;
  let sessionRepo: SqliteSessionRepository;
  let fileRepo: SqliteFileRepository;
  let checkpointRepo: SqliteCheckpointRepository;

  const validSessionId = "00000000-0000-4000-8000-000000000001";
  const validFileId = "20000000-0000-4000-8000-000000000001";
  const validFileVersionId = "30000000-0000-4000-8000-000000000001";

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");

    // Run schema migration
    const migrationSql = readFileSync(
      resolve(__dirname, "../../../db/migrations/001_initial.sql"),
      "utf8",
    );
    db.exec(migrationSql);

    sessionRepo = new SqliteSessionRepository(db);
    fileRepo = new SqliteFileRepository(db);
    checkpointRepo = new SqliteCheckpointRepository(db);

    // 1. Create a parent session
    const session: Session = {
      id: validSessionId,
      status: "active",
      startedAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      endedAt: null,
    };
    await sessionRepo.save(session);

    // 2. Create a file reference and version so foreign keys are satisfied
    const file: FileReference = {
      id: validFileId,
      displayName: "project.ts",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\src\\project.ts",
        verifiedAt: "2026-10-25T00:00:00.000Z",
      },
    };
    await fileRepo.saveReference(file);

    const version: FileVersion = {
      id: validFileVersionId,
      sessionId: validSessionId,
      fileId: validFileId,
      capturedAt: "2026-10-25T00:05:00.000Z",
      contentHash: "c".repeat(64),
      byteLength: 512,
      mediaType: "text/typescript",
    };
    await fileRepo.addVersion(version);
  });

  it("saves and retrieves a checkpoint with linked file versions and boolean kept status", async () => {
    const checkpoint: Checkpoint = {
      id: "40000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      name: "Milestone 1",
      createdAt: "2026-10-25T00:10:00.000Z",
      kept: true,
      fileVersionIds: [validFileVersionId],
      browserVisitIds: ["50000000-0000-4000-8000-000000000001"],
      projectReferences: [
        {
          displayName: "Main Project",
          folderId: "60000000-0000-4000-8000-000000000001",
        },
      ],
    };

    const saveResult = await checkpointRepo.save(checkpoint);
    expect(saveResult.ok).toBe(true);

    const getResult = await checkpointRepo.get(checkpoint.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toEqual(checkpoint);
      expect(getResult.value?.kept).toBe(true);
      expect(getResult.value?.fileVersionIds).toContain(validFileVersionId);
    }
  });

  it("lists checkpoints ordered by created_at DESC", async () => {
    const cp1: Checkpoint = {
      id: "40000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      name: "Checkpoint 1 (Old)",
      createdAt: "2026-10-25T00:10:00.000Z",
      kept: false,
      fileVersionIds: [],
      browserVisitIds: [],
      projectReferences: [],
    };

    const cp2: Checkpoint = {
      id: "40000000-0000-4000-8000-000000000002",
      sessionId: validSessionId,
      name: "Checkpoint 2 (New)",
      createdAt: "2026-10-25T00:20:00.000Z",
      kept: true,
      fileVersionIds: [],
      browserVisitIds: [],
      projectReferences: [],
    };

    await checkpointRepo.save(cp1);
    await checkpointRepo.save(cp2);

    const listResult = await checkpointRepo.list(validSessionId);
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(2);
      expect(listResult.value[0]!.name).toBe("Checkpoint 2 (New)");
      expect(listResult.value[1]!.name).toBe("Checkpoint 1 (Old)");
    }
  });

  it("filters kept checkpoints and updates kept flag with setKept", async () => {
    const cp: Checkpoint = {
      id: "40000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      name: "Pinnable Checkpoint",
      createdAt: "2026-10-25T00:10:00.000Z",
      kept: false,
      fileVersionIds: [],
      browserVisitIds: [],
      projectReferences: [],
    };
    await checkpointRepo.save(cp);

    let keptList = await checkpointRepo.listKept(validSessionId);
    expect(keptList.ok).toBe(true);
    if (keptList.ok) {
      expect(keptList.value).toHaveLength(0);
    }

    // Pin checkpoint
    const setKeptResult = await checkpointRepo.setKept(cp.id, true);
    expect(setKeptResult.ok).toBe(true);

    keptList = await checkpointRepo.listKept(validSessionId);
    expect(keptList.ok).toBe(true);
    if (keptList.ok) {
      expect(keptList.value).toHaveLength(1);
      expect(keptList.value[0]?.id).toBe(cp.id);
      expect(keptList.value[0]?.kept).toBe(true);
    }
  });

  it("deletes a checkpoint and cascades removal of junction rows", async () => {
    const cp: Checkpoint = {
      id: "40000000-0000-4000-8000-000000000001",
      sessionId: validSessionId,
      name: "Delete Me",
      createdAt: "2026-10-25T00:10:00.000Z",
      kept: false,
      fileVersionIds: [validFileVersionId],
      browserVisitIds: ["50000000-0000-4000-8000-000000000001"],
      projectReferences: [],
    };
    await checkpointRepo.save(cp);

    const deleteResult = await checkpointRepo.delete(cp.id);
    expect(deleteResult.ok).toBe(true);

    const getResult = await checkpointRepo.get(cp.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBeNull();
    }

    // Junction rows also removed
    const fvJunction = db
      .prepare(
        "SELECT COUNT(*) as count FROM checkpoint_file_versions WHERE checkpoint_id = ?",
      )
      .get(cp.id) as { count: number };
    expect(fvJunction.count).toBe(0);
  });

  it("rejects saving a checkpoint referencing non-existent session or file versions", async () => {
    const badSessionCp: Checkpoint = {
      id: "40000000-0000-4000-8000-000000000001",
      sessionId: "99999999-0000-4000-8000-000000000001",
      name: "Invalid Session",
      createdAt: "2026-10-25T00:10:00.000Z",
      kept: false,
      fileVersionIds: [],
      browserVisitIds: [],
      projectReferences: [],
    };
    const badSessionResult = await checkpointRepo.save(badSessionCp);
    expect(badSessionResult.ok).toBe(false);
    if (!badSessionResult.ok) {
      expect(badSessionResult.error.code).toBe("NOT_FOUND");
    }

    const badVersionCp: Checkpoint = {
      id: "40000000-0000-4000-8000-000000000002",
      sessionId: validSessionId,
      name: "Invalid Version",
      createdAt: "2026-10-25T00:10:00.000Z",
      kept: false,
      fileVersionIds: ["99999999-0000-4000-8000-000000000002"],
      browserVisitIds: [],
      projectReferences: [],
    };
    const badVersionResult = await checkpointRepo.save(badVersionCp);
    expect(badVersionResult.ok).toBe(false);
    if (!badVersionResult.ok) {
      expect(badVersionResult.error.code).toBe("NOT_FOUND");
    }
  });
});
