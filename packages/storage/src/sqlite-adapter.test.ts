import { resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "@rewind/contracts";
import { SqliteStorageAdapter } from "./sqlite-adapter";

function removeFixtureDirectory(directory: string): void {
  const scoped = relative(resolve(tmpdir()), resolve(directory));
  if (
    isAbsolute(scoped) ||
    scoped.startsWith("..") ||
    !scoped.startsWith("rewind-audit-")
  ) {
    throw new Error("Refusing cleanup outside the audit fixture directory.");
  }
  rmSync(directory, { recursive: true, force: true });
}

describe("SqliteStorageAdapter", () => {
  const migrationPath = resolve(
    __dirname,
    "../../../db/migrations/001_initial.sql",
  );

  it("keeps the same repositories and data when open is called twice", async () => {
    const adapter = new SqliteStorageAdapter(":memory:", migrationPath);
    try {
      expect((await adapter.open()).ok).toBe(true);
      const session: Session = {
        id: "00000000-0000-4000-8000-000000000001",
        status: "active",
        startedAt: "2026-10-25T00:00:00.000Z",
        updatedAt: "2026-10-25T00:00:00.000Z",
        endedAt: null,
      };
      expect((await adapter.repositories.sessions.save(session)).ok).toBe(true);
      expect((await adapter.open()).ok).toBe(true);
      expect(await adapter.repositories.sessions.get(session.id)).toEqual({
        ok: true,
        value: session,
      });
    } finally {
      await adapter.close();
    }
  });

  it("does not report a usable database when no schema exists", async () => {
    const adapter = new SqliteStorageAdapter();
    try {
      expect(await adapter.open()).toMatchObject({ ok: false });
      expect(() => adapter.repositories).toThrow();
    } finally {
      await adapter.close();
    }
  });

  it("closes a failed open and returns a content-free error", async () => {
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    const adapter = new SqliteStorageAdapter(
      ":memory:",
      resolve(__dirname, "synthetic-private-path", "missing.sql"),
    );
    try {
      const result = await adapter.open();
      expect(result).toEqual({
        ok: false,
        error: { code: "INTERNAL", message: "Failed to open storage adapter." },
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(() => adapter.repositories).toThrow();
    } finally {
      await adapter.close();
      close.mockRestore();
    }
  });

  it("rolls back a failed migration before closing the database", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "rewind-audit-"));
    const databasePath = resolve(directory, "synthetic.sqlite");
    const failedMigration = resolve(directory, "failed.sql");
    writeFileSync(
      failedMigration,
      "CREATE TABLE audit_partial (id TEXT); INVALID SQL;",
    );
    const adapter = new SqliteStorageAdapter(databasePath, failedMigration);
    try {
      expect((await adapter.open()).ok).toBe(false);
      const inspection = new DatabaseSync(databasePath);
      try {
        expect(
          inspection
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'audit_partial'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        inspection.close();
      }
    } finally {
      await adapter.close();
      removeFixtureDirectory(directory);
    }
  });

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
});
