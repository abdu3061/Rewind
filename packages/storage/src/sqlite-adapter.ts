import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { failure, type Repositories, type Result } from "@rewind/contracts";
import { SqliteActivityRepository } from "./activity-repository";
import { SqliteCheckpointRepository } from "./checkpoint-repository";
import { SqliteFileRepository } from "./file-repository";
import { SqliteSearchRepository } from "./search-repository";
import { SqliteSessionRepository } from "./session-repository";
import type { StorageAdapter } from "./index";
import { verifyRepositorySchema } from "./repositories";

export class SqliteStorageAdapter implements StorageAdapter {
  private db: DatabaseSync | null = null;
  private _repositories: Repositories | null = null;

  constructor(
    private readonly dbPath: string = ":memory:",
    private readonly migrationPath?: string,
  ) {}

  get repositories(): Repositories {
    if (!this._repositories) {
      throw new Error("StorageAdapter is not open. Call open() first.");
    }
    return this._repositories;
  }

  async open(): Promise<Result<void>> {
    if (this.db) {
      return this._repositories
        ? { ok: true, value: undefined }
        : failure(
            "UNAVAILABLE",
            "Close the failed storage adapter before reopening.",
          );
    }
    try {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA foreign_keys = ON;");

      if (this.migrationPath) {
        const sql = readFileSync(this.migrationPath, "utf8");
        this.db.exec("BEGIN");
        this.db.exec(sql);
      }

      // A successful open must expose usable repositories, even when opening
      // an existing fixture database without a migration path.
      verifyRepositorySchema(this.db);
      if (this.db.isTransaction) this.db.exec("COMMIT");

      this._repositories = {
        sessions: new SqliteSessionRepository(this.db),
        activities: new SqliteActivityRepository(this.db),
        files: new SqliteFileRepository(this.db),
        checkpoints: new SqliteCheckpointRepository(this.db),
        search: new SqliteSearchRepository(this.db),
      };

      return { ok: true, value: undefined };
    } catch {
      this._repositories = null;
      if (this.db) {
        try {
          if (this.db.isTransaction) this.db.exec("ROLLBACK");
        } catch {
          // Closing must still be attempted if rollback fails.
        }
        try {
          this.db.close();
          this.db = null;
        } catch {
          // Retain the handle so close() can be retried; never expose repositories.
        }
      }
      return failure("INTERNAL", "Failed to open storage adapter.");
    }
  }

  async close(): Promise<Result<void>> {
    this._repositories = null;
    try {
      if (this.db) {
        this.db.close();
        this.db = null;
        this._repositories = null;
      }
      return { ok: true, value: undefined };
    } catch {
      return failure("INTERNAL", "Failed to close storage adapter.");
    }
  }

  async usage(): Promise<
    Result<{ metadataBytes: number; snapshotBytes: number }>
  > {
    if (!this.db || !this._repositories)
      return failure("UNAVAILABLE", "Storage is not open.");
    try {
      let metadataBytes = 0;
      if (this.dbPath !== ":memory:") {
        metadataBytes = statSync(this.dbPath).size;
      }

      return {
        ok: true,
        value: {
          metadataBytes,
          snapshotBytes: 0,
        },
      };
    } catch {
      return failure("INTERNAL", "Failed to calculate storage usage.");
    }
  }
}
