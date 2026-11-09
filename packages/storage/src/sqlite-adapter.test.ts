import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileReference, FileVersion, Session } from "@rewind/contracts";
import { SqliteStorageAdapter } from "./sqlite-adapter";

describe("SqliteStorageAdapter", () => {
  const migrationsDir = resolve(__dirname, "../../../db/migrations");
  const migrationPath = resolve(migrationsDir, "001_initial.sql");

  it("opens database, executes migrations, exposes all repositories, and closes cleanly", async () => {
    const adapter = new SqliteStorageAdapter(":memory:", migrationPath);

    // Opening adapter
    const openResult = await adapter.open();
    expect(openResult.ok).toBe(true);

    // Repositories are accessible
    expect(adapter.repositories).toBeDefined();
    expect(adapter.repositories.sessions).toBeDefined();
    expect(adapter.repositories.activities).toBeDefined();
    expect(adapter.repositories.files).toBeDefined();
    expect(adapter.repositories.checkpoints).toBeDefined();
    expect(adapter.repositories.search).toBeDefined();

    // Verify session save through adapter
    const session: Session = {
      id: "00000000-0000-4000-8000-000000000001",
      status: "active",
      startedAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      endedAt: null,
    };
    const saveResult = await adapter.repositories.sessions.save(session);
    expect(saveResult.ok).toBe(true);

    const getResult = await adapter.repositories.sessions.get(session.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toEqual(session);
    }

    // Usage report
    const usageResult = await adapter.usage();
    expect(usageResult.ok).toBe(true);

    // Closing adapter
    const closeResult = await adapter.close();
    expect(closeResult.ok).toBe(true);
  });

  it("applies migrations from a directory and records them in schema_migrations", async () => {
    const adapter = new SqliteStorageAdapter(":memory:", migrationsDir);
    await adapter.open();

    const db = adapter.database;
    const migrations = db
      .prepare("SELECT version, name FROM schema_migrations")
      .all() as { version: number; name: string }[];

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.version).toBe(1);
    expect(migrations[0]?.name).toBe("001_initial.sql");

    await adapter.close();
  });

  it("reopens persistent database without re-executing applied migrations", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rewind-db-test-"));
    const dbFile = join(tempDir, "test.sqlite");

    try {
      // 1. Open and write data
      const adapter1 = new SqliteStorageAdapter(dbFile, migrationsDir);
      await adapter1.open();

      const session: Session = {
        id: "00000000-0000-4000-8000-000000000001",
        status: "active",
        startedAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
        endedAt: null,
      };
      await adapter1.repositories.sessions.save(session);
      await adapter1.close();

      // 2. Reopen same file
      const adapter2 = new SqliteStorageAdapter(dbFile, migrationsDir);
      await adapter2.open();

      const retrieved = await adapter2.repositories.sessions.get(session.id);
      expect(retrieved.ok).toBe(true);
      if (retrieved.ok) {
        expect(retrieved.value).toEqual(session);
      }

      await adapter2.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accurately calculates storage usage including file sizes and snapshot bytes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rewind-usage-test-"));
    const dbFile = join(tempDir, "test-usage.sqlite");

    try {
      const adapter = new SqliteStorageAdapter(dbFile, migrationsDir);
      await adapter.open();

      const sessionId = "00000000-0000-4000-8000-000000000001";
      const fileId = "20000000-0000-4000-8000-000000000001";

      await adapter.repositories.sessions.save({
        id: sessionId,
        status: "active",
        startedAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
        endedAt: null,
      });

      const file: FileReference = {
        id: fileId,
        displayName: "data.bin",
        identity: {
          kind: "verified-path",
          absolutePath: "C:\\data.bin",
          verifiedAt: "2026-10-25T00:00:00.000Z",
        },
      };
      await adapter.repositories.files.saveReference(file);

      const version: FileVersion = {
        id: "30000000-0000-4000-8000-000000000001",
        sessionId,
        fileId,
        capturedAt: "2026-10-25T00:01:00.000Z",
        contentHash: "f".repeat(64),
        byteLength: 4096,
        mediaType: "application/octet-stream",
      };
      await adapter.repositories.files.addVersion(version);

      const usage = await adapter.usage();
      expect(usage.ok).toBe(true);
      if (usage.ok) {
        expect(usage.value.metadataBytes).toBeGreaterThan(0);
        expect(usage.value.snapshotBytes).toBe(4096);
      }

      await adapter.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
