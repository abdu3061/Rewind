import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "@rewind/contracts";
import { SqliteStorageAdapter } from "./sqlite-adapter";

describe("SqliteStorageAdapter", () => {
  const migrationPath = resolve(
    __dirname,
    "../../../db/migrations/001_initial.sql",
  );

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
