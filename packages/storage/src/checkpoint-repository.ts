import { DatabaseSync } from "node:sqlite";
import {
  checkpointSchema,
  failure,
  idSchema,
  timestampSchema,
  type Checkpoint,
  type CheckpointQueryOptions,
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

  private hydrateCheckpoint(row: CheckpointRow): Result<Checkpoint> {
    try {
      // 1. Fetch linked file version IDs
      const fvStmt = this.db.prepare(`
        SELECT file_version_id
        FROM checkpoint_file_versions
        WHERE checkpoint_id = ?
        ORDER BY file_version_id ASC
      `);
      const fvRows = fvStmt.all(row.id) as unknown as {
        file_version_id: string;
      }[];
      const fileVersionIds = fvRows.map((r) => r.file_version_id);

      // 2. Fetch linked browser visit IDs
      const bvStmt = this.db.prepare(`
        SELECT browser_visit_id
        FROM checkpoint_browser_visits
        WHERE checkpoint_id = ?
        ORDER BY browser_visit_id ASC
      `);
      const bvRows = bvStmt.all(row.id) as unknown as {
        browser_visit_id: string;
      }[];
      const browserVisitIds = bvRows.map((r) => r.browser_visit_id);

      let parsedProjects: unknown = [];
      if (row.project_references) {
        parsedProjects = JSON.parse(row.project_references);
      }

      const candidate = {
        id: row.id,
        sessionId: row.session_id,
        name: row.name,
        createdAt: row.created_at,
        kept: row.kept === 1,
        fileVersionIds,
        browserVisitIds,
        projectReferences: parsedProjects,
      };

      const parsed = checkpointSchema.safeParse(candidate);
      if (!parsed.success) {
        return failure(
          "INTEGRITY_FAILURE",
          `Corrupted checkpoint record ${row.id}: ${parsed.error.issues[0]?.message ?? "Schema mismatch"}`,
        );
      }

      return { ok: true, value: parsed.data };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to hydrate checkpoint ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async save(checkpoint: Checkpoint): Promise<Result<void>> {
    const parsed = checkpointSchema.safeParse(checkpoint);
    if (!parsed.success) {
      return failure(
        "INVALID_INPUT",
        `Invalid checkpoint input: ${parsed.error.issues[0]?.message ?? "Validation failed"}`,
      );
    }

    try {
      // 1. Verify referenced session exists
      const sessionCheck = this.db.prepare(
        "SELECT id FROM sessions WHERE id = ?",
      );
      if (!sessionCheck.get(checkpoint.sessionId)) {
        return failure(
          "NOT_FOUND",
          `Referenced session ${checkpoint.sessionId} does not exist.`,
        );
      }

      // 2. Verify all referenced file versions exist
      if (checkpoint.fileVersionIds.length > 0) {
        const fvCheck = this.db.prepare(
          "SELECT id FROM file_versions WHERE id = ?",
        );
        for (const fvId of checkpoint.fileVersionIds) {
          if (!fvCheck.get(fvId)) {
            return failure(
              "NOT_FOUND",
              `Referenced file version ${fvId} does not exist.`,
            );
          }
        }
      }

      this.db.exec("BEGIN IMMEDIATE");

      // 3. Upsert main checkpoint record
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

      // 4. Update junction tables
      this.db
        .prepare("DELETE FROM checkpoint_file_versions WHERE checkpoint_id = ?")
        .run(checkpoint.id);
      this.db
        .prepare(
          "DELETE FROM checkpoint_browser_visits WHERE checkpoint_id = ?",
        )
        .run(checkpoint.id);

      if (checkpoint.fileVersionIds.length > 0) {
        const fvStmt = this.db.prepare(`
          INSERT INTO checkpoint_file_versions (checkpoint_id, file_version_id)
          VALUES (?, ?)
        `);
        for (const fvId of checkpoint.fileVersionIds) {
          fvStmt.run(checkpoint.id, fvId);
        }
      }

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
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Safe ignore
      }
      return failure(
        "INTERNAL",
        `Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async get(id: Id): Promise<Result<Checkpoint | null>> {
    const validId = idSchema.safeParse(id);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid checkpoint id: ${id}`);
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, name, created_at, kept, project_references
        FROM checkpoints
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as CheckpointRow | undefined;
      if (!row) {
        return { ok: true, value: null };
      }

      return this.hydrateCheckpoint(row);
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(sessionId: Id): Promise<Result<Checkpoint[]>> {
    const validId = idSchema.safeParse(sessionId);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid session id: ${sessionId}`);
    }

    return this.queryCheckpoints({
      sessionId,
      order: "desc",
    });
  }

  async listKept(sessionId?: Id): Promise<Result<Checkpoint[]>> {
    if (sessionId) {
      const validId = idSchema.safeParse(sessionId);
      if (!validId.success) {
        return failure("INVALID_INPUT", `Invalid session id: ${sessionId}`);
      }
    }

    return this.queryCheckpoints({
      ...(sessionId !== undefined ? { sessionId } : {}),
      keptOnly: true,
      order: "desc",
    });
  }

  async setKept(id: Id, kept: boolean): Promise<Result<void>> {
    const validId = idSchema.safeParse(id);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid checkpoint id: ${id}`);
    }

    try {
      const checkStmt = this.db.prepare(
        "SELECT id FROM checkpoints WHERE id = ?",
      );
      if (!checkStmt.get(id)) {
        return failure("NOT_FOUND", `Checkpoint with id ${id} not found.`);
      }

      const stmt = this.db.prepare(`
        UPDATE checkpoints
        SET kept = ?
        WHERE id = ?
      `);
      stmt.run(kept ? 1 : 0, id);

      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to update checkpoint kept status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async delete(id: Id): Promise<Result<void>> {
    const validId = idSchema.safeParse(id);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid checkpoint id: ${id}`);
    }

    try {
      const checkStmt = this.db.prepare(
        "SELECT id FROM checkpoints WHERE id = ?",
      );
      if (!checkStmt.get(id)) {
        return failure("NOT_FOUND", `Checkpoint with id ${id} not found.`);
      }

      const stmt = this.db.prepare("DELETE FROM checkpoints WHERE id = ?");
      stmt.run(id);

      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to delete checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async queryCheckpoints(
    options: CheckpointQueryOptions,
  ): Promise<Result<Checkpoint[]>> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.sessionId) {
      const validId = idSchema.safeParse(options.sessionId);
      if (!validId.success) {
        return failure(
          "INVALID_INPUT",
          `Invalid session id: ${options.sessionId}`,
        );
      }
      conditions.push("session_id = ?");
      params.push(options.sessionId);
    }

    if (options.keptOnly) {
      conditions.push("kept = 1");
    }

    if (options.after) {
      const validAfter = timestampSchema.safeParse(options.after);
      if (!validAfter.success) {
        return failure(
          "INVALID_INPUT",
          `Invalid after timestamp: ${options.after}`,
        );
      }
      conditions.push("created_at > ?");
      params.push(options.after);
    }

    if (options.before) {
      const validBefore = timestampSchema.safeParse(options.before);
      if (!validBefore.success) {
        return failure(
          "INVALID_INPUT",
          `Invalid before timestamp: ${options.before}`,
        );
      }
      conditions.push("created_at < ?");
      params.push(options.before);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderDirection =
      options.order?.toLowerCase() === "asc" ? "ASC" : "DESC";
    const limitCount = Math.min(Math.max(options.limit ?? 100, 1), 500);

    const sql = `
      SELECT id, session_id, name, created_at, kept, project_references
      FROM checkpoints
      ${whereClause}
      ORDER BY created_at ${orderDirection}
      LIMIT ?
    `;
    params.push(limitCount);

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as unknown as CheckpointRow[];

      const checkpoints: Checkpoint[] = [];
      for (const row of rows) {
        const result = this.hydrateCheckpoint(row);
        if (!result.ok) return result;
        checkpoints.push(result.value);
      }

      return { ok: true, value: checkpoints };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to query checkpoints: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
