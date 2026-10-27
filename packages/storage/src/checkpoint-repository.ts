import { DatabaseSync } from "node:sqlite";
import {
  failure,
  type Checkpoint,
  type CheckpointRepository,
  type Id,
  type Result,
} from "@rewind/contracts";

interface CheckpointRow {
  id: string;
  session_id: string;
  name: string;
  created_at: string;
  kept: number;
  project_references: string | null;
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly db: DatabaseSync) {}

  private hydrateCheckpoint(row: CheckpointRow): Checkpoint {
    // 1. Fetch linked file version IDs from the junction table
    const fvStmt = this.db.prepare(`
      SELECT file_version_id
      FROM checkpoint_file_versions
      WHERE checkpoint_id = ?
    `);
    const fvRows = fvStmt.all(row.id) as unknown as {
      file_version_id: string;
    }[];
    const fileVersionIds = fvRows.map((r) => r.file_version_id);

    // 2. Fetch linked browser visit IDs from the junction table
    const bvStmt = this.db.prepare(`
      SELECT browser_visit_id
      FROM checkpoint_browser_visits
      WHERE checkpoint_id = ?
    `);
    const bvRows = bvStmt.all(row.id) as unknown as {
      browser_visit_id: string;
    }[];
    const browserVisitIds = bvRows.map((r) => r.browser_visit_id);

    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      createdAt: row.created_at,
      kept: row.kept === 1,
      fileVersionIds,
      browserVisitIds,
      projectReferences: row.project_references
        ? JSON.parse(row.project_references)
        : [],
    };
  }

  async save(checkpoint: Checkpoint): Promise<Result<void>> {
    try {
      this.db.exec("BEGIN");

      // 1. Insert or update the main checkpoint record
      const stmt = this.db.prepare(`
        INSERT INTO checkpoints (id, session_id, name, created_at, kept, project_references)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          name = excluded.name,
          created_at = excluded.created_at,
          kept = excluded.kept,
          project_references = excluded.project_references
      `);

      stmt.run(
        checkpoint.id,
        checkpoint.sessionId,
        checkpoint.name,
        checkpoint.createdAt,
        checkpoint.kept ? 1 : 0,
        JSON.stringify(checkpoint.projectReferences),
      );

      // 2. Clear old junction entries (if updating an existing checkpoint)
      this.db
        .prepare("DELETE FROM checkpoint_file_versions WHERE checkpoint_id = ?")
        .run(checkpoint.id);
      this.db
        .prepare(
          "DELETE FROM checkpoint_browser_visits WHERE checkpoint_id = ?",
        )
        .run(checkpoint.id);

      // 3. Insert linked file versions
      if (checkpoint.fileVersionIds.length > 0) {
        const fvStmt = this.db.prepare(`
          INSERT INTO checkpoint_file_versions (checkpoint_id, file_version_id)
          VALUES (?, ?)
        `);
        for (const fvId of checkpoint.fileVersionIds) {
          fvStmt.run(checkpoint.id, fvId);
        }
      }

      // 4. Insert linked browser visits
      if (checkpoint.browserVisitIds.length > 0) {
        const bvStmt = this.db.prepare(`
          INSERT INTO checkpoint_browser_visits (checkpoint_id, browser_visit_id)
          VALUES (?, ?)
        `);
        for (const bvId of checkpoint.browserVisitIds) {
          bvStmt.run(checkpoint.id, bvId);
        }
      }

      this.db.exec("COMMIT");
      return { ok: true, value: undefined };
    } catch (error) {
      this.db.exec("ROLLBACK");
      return failure(
        "INTERNAL",
        `Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async get(id: Id): Promise<Result<Checkpoint | null>> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, name, created_at, kept, project_references
        FROM checkpoints
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as CheckpointRow | undefined;
      return { ok: true, value: row ? this.hydrateCheckpoint(row) : null };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(sessionId: Id): Promise<Result<Checkpoint[]>> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, name, created_at, kept, project_references
        FROM checkpoints
        WHERE session_id = ?
        ORDER BY created_at DESC
      `);

      const rows = stmt.all(sessionId) as unknown as CheckpointRow[];
      const checkpoints = rows.map((r) => this.hydrateCheckpoint(r));
      return { ok: true, value: checkpoints };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to list checkpoints: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
