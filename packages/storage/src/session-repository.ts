import { DatabaseSync } from "node:sqlite";
import {
  failure,
  idSchema,
  sessionSchema,
  type Id,
  type Result,
  type Session,
  type SessionRepository,
} from "@rewind/contracts";

interface SessionRow {
  id: string;
  status: "active" | "paused" | "ended";
  started_at: string;
  updated_at: string;
  ended_at: string | null;
}

function rowToSession(row: SessionRow): Result<Session> {
  const candidate = {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };

  const parsed = sessionSchema.safeParse(candidate);
  if (!parsed.success) {
    return failure(
      "INTEGRITY_FAILURE",
      `Corrupted session record ${row.id}: ${parsed.error.issues[0]?.message ?? "Schema mismatch"}`,
    );
  }
  return { ok: true, value: parsed.data };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  async save(session: Session): Promise<Result<void>> {
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) {
      return failure(
        "INVALID_INPUT",
        `Invalid session input: ${parsed.error.issues[0]?.message ?? "Validation failed"}`,
      );
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO sessions (id, status, started_at, updated_at, ended_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          ended_at = excluded.ended_at
      `);

      stmt.run(
        session.id,
        session.status,
        session.startedAt,
        session.updatedAt,
        session.endedAt,
      );

      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to save session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async get(id: Id): Promise<Result<Session | null>> {
    const validId = idSchema.safeParse(id);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid session id: ${id}`);
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, status, started_at, updated_at, ended_at
        FROM sessions
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as SessionRow | undefined;
      if (!row) {
        return { ok: true, value: null };
      }

      return rowToSession(row);
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getLatest(): Promise<Result<Session | null>> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, status, started_at, updated_at, ended_at
        FROM sessions
        ORDER BY started_at DESC
        LIMIT 1
      `);

      const row = stmt.get() as unknown as SessionRow | undefined;
      if (!row) {
        return { ok: true, value: null };
      }

      return rowToSession(row);
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get latest session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(limit: number = 50): Promise<Result<Session[]>> {
    if (limit <= 0) {
      return failure("INVALID_INPUT", "Limit must be a positive number.");
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, status, started_at, updated_at, ended_at
        FROM sessions
        ORDER BY started_at DESC
        LIMIT ?
      `);

      const rows = stmt.all(limit) as unknown as SessionRow[];
      const sessions: Session[] = [];
      for (const row of rows) {
        const result = rowToSession(row);
        if (!result.ok) return result;
        sessions.push(result.value);
      }

      return { ok: true, value: sessions };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async delete(id: Id): Promise<Result<void>> {
    const validId = idSchema.safeParse(id);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid session id: ${id}`);
    }

    try {
      const checkStmt = this.db.prepare("SELECT id FROM sessions WHERE id = ?");
      const existing = checkStmt.get(id);
      if (!existing) {
        return failure("NOT_FOUND", `Session with id ${id} not found.`);
      }

      const stmt = this.db.prepare("DELETE FROM sessions WHERE id = ?");
      stmt.run(id);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
