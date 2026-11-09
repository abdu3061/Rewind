import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { failure, type Repositories, type Result } from "@rewind/contracts";
import { SqliteActivityRepository } from "./activity-repository";
import { SqliteCheckpointRepository } from "./checkpoint-repository";
import { SqliteFileRepository } from "./file-repository";
import { SqliteSearchRepository } from "./search-repository";
import { SqliteSessionRepository } from "./session-repository";
import type { StorageAdapter } from "./index";

function getDefaultMigrationPath(): string | undefined {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const candidate = resolve(
      dirname(currentFile),
      "../../../db/migrations/001_initial.sql",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // In bundler environments import.meta.url may differ
  }
  return undefined;
}

const EMBEDDED_INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activities_session ON activities (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activities_session_type ON activities (session_id, type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activities_occurred_at ON activities (occurred_at DESC);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('verified-path', 'unverified')),
  absolute_path TEXT,
  verified_at TEXT,
  observed_title TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_display_name ON files (display_name);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions (file_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_file_versions_session ON file_versions (session_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_versions_hash ON file_versions (content_hash);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  kept INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),
  project_references TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_kept ON checkpoints (kept, created_at DESC);

CREATE TABLE IF NOT EXISTS checkpoint_file_versions (
  checkpoint_id TEXT NOT NULL,
  file_version_id TEXT NOT NULL,
  PRIMARY KEY (checkpoint_id, file_version_id),
  FOREIGN KEY (checkpoint_id) REFERENCES checkpoints (id) ON DELETE CASCADE,
  FOREIGN KEY (file_version_id) REFERENCES file_versions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cp_fv_version ON checkpoint_file_versions (file_version_id);

CREATE TABLE IF NOT EXISTS checkpoint_browser_visits (
  checkpoint_id TEXT NOT NULL,
  browser_visit_id TEXT NOT NULL,
  PRIMARY KEY (checkpoint_id, browser_visit_id),
  FOREIGN KEY (checkpoint_id) REFERENCES checkpoints (id) ON DELETE CASCADE
);
`;

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

  get database(): DatabaseSync {
    if (!this.db) {
      throw new Error("StorageAdapter is not open. Call open() first.");
    }
    return this.db;
  }

  async open(): Promise<Result<void>> {
    try {
      this.db = new DatabaseSync(this.dbPath);

      // Core pragmas for data integrity and performance
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 5000;");

      if (this.dbPath !== ":memory:") {
        try {
          this.db.exec("PRAGMA journal_mode = WAL;");
          this.db.exec("PRAGMA synchronous = NORMAL;");
        } catch {
          // In some restricted environments WAL might not be supported
        }
      }

      // Execute versioned migrations
      const migrationTarget = this.migrationPath ?? getDefaultMigrationPath();
      if (migrationTarget && existsSync(migrationTarget)) {
        this.applyMigrations(migrationTarget);
      } else {
        this.applyEmbeddedSchema();
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

  private applyEmbeddedSchema(): void {
    if (!this.db) return;

    this.db.exec(EMBEDDED_INITIAL_SCHEMA);
    const checkStmt = this.db.prepare(
      "SELECT version FROM schema_migrations WHERE version = 1",
    );
    const applied = checkStmt.get();
    if (!applied) {
      const insertStmt = this.db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      );
      insertStmt.run(1, "001_initial.sql", new Date().toISOString());
    }
  }

  private applyMigrations(target: string): void {
    if (!this.db) return;

    // Ensure migrations table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    if (!existsSync(target)) {
      this.applyEmbeddedSchema();
      return;
    }

    const stats = statSync(target);
    const filesToRun: { version: number; name: string; path: string }[] = [];

    if (stats.isDirectory()) {
      const files = readdirSync(target)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const file of files) {
        const match = file.match(/^(\d+)_/);
        const version = match ? Number.parseInt(match[1]!, 10) : 1;
        filesToRun.push({
          version,
          name: file,
          path: join(target, file),
        });
      }
    } else {
      const fileName = basename(target);
      const match = fileName.match(/^(\d+)_/);
      const version = match ? Number.parseInt(match[1]!, 10) : 1;
      filesToRun.push({
        version,
        name: fileName,
        path: target,
      });
    }

    const checkStmt = this.db.prepare(
      "SELECT version FROM schema_migrations WHERE version = ?",
    );
    const insertStmt = this.db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const migration of filesToRun) {
      const applied = checkStmt.get(migration.version);
      if (!applied) {
        const sql = readFileSync(migration.path, "utf8");
        this.db.exec("BEGIN IMMEDIATE;");
        try {
          this.db.exec(sql);
          insertStmt.run(
            migration.version,
            migration.name,
            new Date().toISOString(),
          );
          this.db.exec("COMMIT;");
        } catch (error) {
          try {
            this.db.exec("ROLLBACK;");
          } catch {
            // Safe ignore
          }
          throw error;
        }
      }
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

      let snapshotBytes = 0;
      if (this.db) {
        try {
          const stmt = this.db.prepare(
            "SELECT COALESCE(SUM(byte_length), 0) as total FROM file_versions",
          );
          const row = stmt.get() as unknown as { total: number };
          snapshotBytes = Number(row?.total ?? 0);
        } catch {
          // Table may not exist yet
        }
      }

      return {
        ok: true,
        value: {
          metadataBytes,
          snapshotBytes,
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
