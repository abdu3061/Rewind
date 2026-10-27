import { DatabaseSync } from "node:sqlite";
import {
  failure,
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

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  async save(session: Session): Promise<Result<void>> {
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
    try {
      const stmt = this.db.prepare(`
        SELECT id, status, started_at, updated_at, ended_at
        FROM sessions
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as SessionRow | undefined;
      return { ok: true, value: row ? rowToSession(row) : null };
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
      return { ok: true, value: row ? rowToSession(row) : null };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get latest session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
