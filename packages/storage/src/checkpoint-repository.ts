import type { DatabaseConnection } from "./database";
import {
  failure,
  checkpointSchema,
  checkpointListQuerySchema,
  checkpointSummarySchema,
  idSchema,
  type Checkpoint,
  type CheckpointRepository,
  type Id,
  type Result,
  type CheckpointListQuery,
  type CheckpointSummary,
} from "@rewind/contracts";

interface CheckpointRow {
  id: string;
  session_id: string;
  name: string;
  created_at: string;
  kept: number;
  project_references: string | null;
}
function kept(value: number): boolean {
  if (value !== 0 && value !== 1) throw new Error("CHECKPOINT_KEEP_INVALID");
  return value === 1;
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly db: DatabaseConnection) {}

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
    const activityIds = this.db
      .prepare(
        "SELECT activity_id FROM checkpoint_activities WHERE checkpoint_id=? ORDER BY activity_id",
      )
      .all(row.id)
      .map((r) => (r as { activity_id: string }).activity_id);

    return checkpointSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      createdAt: row.created_at,
      kept: kept(row.kept),
      fileVersionIds,
      activityIds,
      browserVisitIds,
      projectReferences: row.project_references
        ? JSON.parse(row.project_references)
        : [],
    });
  }

  async save(checkpoint: Checkpoint): Promise<Result<void>> {
    const parsed = checkpointSchema.safeParse(checkpoint);
    if (
      !parsed.success ||
      (parsed.success &&
        [
          parsed.data.fileVersionIds,
          parsed.data.browserVisitIds,
          parsed.data.activityIds,
        ].some((ids) => new Set(ids).size !== ids.length))
    )
      return failure(
        "INVALID_INPUT",
        "Checkpoint evidence is invalid or duplicated.",
      );
    checkpoint = parsed.data;
    if (
      checkpoint.browserVisitIds.some(
        (id) => !checkpoint.activityIds.includes(id),
      )
    )
      return failure(
        "INVALID_INPUT",
        "Browser checkpoint references must also be selected activity evidence.",
      );
    let transactionStarted = false;
    try {
      const existing = this.db
        .prepare("SELECT session_id,created_at FROM checkpoints WHERE id=?")
        .get(checkpoint.id);
      if (
        existing &&
        (existing.session_id !== checkpoint.sessionId ||
          existing.created_at !== checkpoint.createdAt)
      )
        return failure(
          "CONFLICT",
          "A checkpoint cannot change its session or creation identity.",
        );
      this.db.exec("BEGIN");
      transactionStarted = true;

      // 1. Insert or update the main checkpoint record
      const stmt = this.db.prepare(`
        INSERT INTO checkpoints (id, session_id, name, created_at, kept, project_references)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
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
      this.db
        .prepare("DELETE FROM checkpoint_activities WHERE checkpoint_id=?")
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
      const activityInsert = this.db.prepare(
        "INSERT INTO checkpoint_activities(checkpoint_id,activity_id) VALUES (?,?)",
      );
      for (const id of checkpoint.activityIds)
        activityInsert.run(checkpoint.id, id);

      this.db.exec("COMMIT");
      return { ok: true, value: undefined };
    } catch {
      if (transactionStarted) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original failure if rollback is no longer possible.
        }
      }
      return failure("INTERNAL", "Checkpoint could not be saved.");
    }
  }

  async get(id: Id): Promise<Result<Checkpoint | null>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "A checkpoint ID is required.");
    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, name, created_at, kept, project_references
        FROM checkpoints
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as CheckpointRow | undefined;
      return { ok: true, value: row ? this.hydrateCheckpoint(row) : null };
    } catch {
      return failure(
        "INTERNAL",
        "Stored checkpoint is unavailable or invalid.",
      );
    }
  }

  async list(sessionId: Id): Promise<Result<Checkpoint[]>> {
    if (!idSchema.safeParse(sessionId).success)
      return failure("INVALID_INPUT", "A session ID is required.");
    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, name, created_at, kept, project_references
        FROM checkpoints
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 100
      `);

      const rows = stmt.all(sessionId) as unknown as CheckpointRow[];
      const checkpoints = rows.map((r) => this.hydrateCheckpoint(r));
      return { ok: true, value: checkpoints };
    } catch {
      return failure(
        "INTERNAL",
        "Stored checkpoints are unavailable or invalid.",
      );
    }
  }

  async query(
    input: CheckpointListQuery,
  ): Promise<Result<CheckpointSummary[]>> {
    const parsed = checkpointListQuerySchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_INPUT",
        "A bounded checkpoint query is required.",
      );
    const query = parsed.data,
      conditions: string[] = [],
      values: (string | number)[] = [];
    if (query.id) {
      conditions.push("c.id=?");
      values.push(query.id);
    }
    if (query.sessionId) {
      conditions.push("c.session_id=?");
      values.push(query.sessionId);
    }
    if (query.before) {
      conditions.push("(c.created_at < ? OR (c.created_at=? AND c.id<?))");
      values.push(
        query.before.createdAt,
        query.before.createdAt,
        query.before.id,
      );
    }
    values.push(query.limit);
    try {
      const rows = this.db
        .prepare(
          `SELECT c.*,
        (SELECT count(*) FROM checkpoint_file_versions v WHERE v.checkpoint_id=c.id) AS version_count,
        (SELECT count(*) FROM checkpoint_activities a WHERE a.checkpoint_id=c.id) AS activity_count
        FROM checkpoints c ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY c.created_at DESC,c.id DESC LIMIT ?`,
        )
        .all(...values);
      return {
        ok: true,
        value: rows.map((value) => {
          const row = value as CheckpointRow & {
            version_count: number;
            activity_count: number;
          };
          return checkpointSummarySchema.parse({
            id: row.id,
            sessionId: row.session_id,
            name: row.name,
            createdAt: row.created_at,
            kept: kept(row.kept),
            fileVersionCount: row.version_count,
            activityCount: row.activity_count,
          });
        }),
      };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Stored checkpoint summaries are unavailable.",
      );
    }
  }
  async remove(id: Id): Promise<Result<void>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "A checkpoint ID is required.");
    try {
      const removed = this.db
        .prepare("DELETE FROM checkpoints WHERE id=?")
        .run(id);
      return Number(removed.changes)
        ? { ok: true, value: undefined }
        : failure("NOT_FOUND", "This checkpoint is no longer available.");
    } catch {
      return failure("UNAVAILABLE", "The checkpoint could not be removed.");
    }
  }
}
