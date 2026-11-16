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
  const parsed = sessionSchema.safeParse({
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failure("INTEGRITY_FAILURE", "Stored session is invalid.");
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  async save(session: Session): Promise<Result<void>> {
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Session input is invalid.");
    session = parsed.data;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO sessions (id, status, started_at, updated_at, ended_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          ended_at = excluded.ended_at
        WHERE sessions.started_at = excluded.started_at
          AND (sessions.status != 'ended' OR excluded.status = 'ended')
      `);

      const saved = stmt.run(
        session.id,
        session.status,
        session.startedAt,
        session.updatedAt,
        session.endedAt,
      );
      if (saved.changes === 0)
        return failure("CONFLICT", "Session identity cannot be changed.");

      return { ok: true, value: undefined };
    } catch {
      return failure("INTERNAL", "Failed to save session.");
    }
  }

  async get(id: Id): Promise<Result<Session | null>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "Session ID is invalid.");
    try {
      const stmt = this.db.prepare(`
        SELECT id, status, started_at, updated_at, ended_at
        FROM sessions
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as SessionRow | undefined;
      return row ? rowToSession(row) : { ok: true, value: null };
    } catch {
      return failure("INTERNAL", "Failed to get session.");
    }
  }

  async getLatest(): Promise<Result<Session | null>> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, status, started_at, updated_at, ended_at
        FROM sessions
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `);

      const row = stmt.get() as unknown as SessionRow | undefined;
      return row ? rowToSession(row) : { ok: true, value: null };
    } catch {
      return failure("INTERNAL", "Failed to get latest session.");
    }
  }
}
