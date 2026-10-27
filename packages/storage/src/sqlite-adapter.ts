import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { failure, type Repositories, type Result } from "@rewind/contracts";
import { SqliteActivityRepository } from "./activity-repository";
import { SqliteCheckpointRepository } from "./checkpoint-repository";
import { SqliteFileRepository } from "./file-repository";
import { SqliteSearchRepository } from "./search-repository";
import { SqliteSessionRepository } from "./session-repository";
import type { StorageAdapter } from "./index";

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
    try {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA foreign_keys = ON;");

      if (this.migrationPath) {
        const sql = readFileSync(this.migrationPath, "utf8");
        this.db.exec(sql);
      }

      this._repositories = {
        sessions: new SqliteSessionRepository(this.db),
        activities: new SqliteActivityRepository(this.db),
        files: new SqliteFileRepository(this.db),
        checkpoints: new SqliteCheckpointRepository(this.db),
        search: new SqliteSearchRepository(this.db),
      };

      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to open storage adapter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async close(): Promise<Result<void>> {
    try {
      if (this.db) {
        this.db.close();
        this.db = null;
        this._repositories = null;
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to close storage adapter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async usage(): Promise<
    Result<{ metadataBytes: number; snapshotBytes: number }>
  > {
    try {
      let metadataBytes = 0;
      if (this.dbPath !== ":memory:") {
        try {
          const stats = statSync(this.dbPath);
          metadataBytes = stats.size;
        } catch {
          // File may not be created yet
        }
      }

      return {
        ok: true,
        value: {
          metadataBytes,
          snapshotBytes: 0,
        },
      };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to calculate storage usage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
