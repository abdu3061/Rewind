import { DatabaseSync } from 'node:sqlite';
import {
  failure,
  type ActivityEvent,
  type ActivityRepository,
  type Id,
  type Result,
  type Timestamp,
} from '@rewind/contracts';

interface ActivityRow {
  id: string;
  session_id: string;
  type: ActivityEvent['type'];
  source: ActivityEvent['source'];
  occurred_at: string;
  payload: string;
}

function rowToActivityEvent(row: ActivityRow): ActivityEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    source: row.source,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload),
  } as ActivityEvent;
}

export class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly db: DatabaseSync) {}

  async append(events: readonly ActivityEvent[]): Promise<Result<void>> {
    if (events.length === 0) {
      return { ok: true, value: undefined };
    }

    try {
      this.db.exec('BEGIN');

      const stmt = this.db.prepare(`
        INSERT INTO activities (id, session_id, type, source, occurred_at, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const event of events) {
        stmt.run(
          event.id,
          event.sessionId,
          event.type,
          event.source,
          event.occurredAt,
          JSON.stringify(event.payload),
        );
      }

      this.db.exec('COMMIT');
      return { ok: true, value: undefined };
    } catch (error) {
      this.db.exec('ROLLBACK');
      return failure(
        'INTERNAL',
        `Failed to append activities: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(sessionId: Id, limit: number, before?: Timestamp): Promise<Result<ActivityEvent[]>> {
    try {
      let rows: ActivityRow[];

      if (before) {
        const stmt = this.db.prepare(`
          SELECT id, session_id, type, source, occurred_at, payload
          FROM activities
          WHERE session_id = ? AND occurred_at < ?
          ORDER BY occurred_at DESC
          LIMIT ?
        `);
        rows = stmt.all(sessionId, before, limit) as unknown as ActivityRow[];
      } else {
        const stmt = this.db.prepare(`
          SELECT id, session_id, type, source, occurred_at, payload
          FROM activities
          WHERE session_id = ?
          ORDER BY occurred_at DESC
          LIMIT ?
        `);
        rows = stmt.all(sessionId, limit) as unknown as ActivityRow[];
      }

      const activities = rows.map(rowToActivityEvent);
      return { ok: true, value: activities };
    } catch (error) {
      return failure(
        'INTERNAL',
        `Failed to list activities: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
