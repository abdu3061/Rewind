import type { DatabaseConnection } from "./database";
import {
  activityEventSchema,
  activityBatchSchema,
  activityCursorSchema,
  failure,
  idSchema,
  timestampSchema,
  type ActivityEvent,
  type ActivityCursor,
  type ActivityRepository,
  type Id,
  type Result,
  type Timestamp,
} from "@rewind/contracts";
import { writeFileReference } from "./file-reference";

interface ActivityRow {
  id: string;
  session_id: string;
  type: ActivityEvent["type"];
  source: ActivityEvent["source"];
  occurred_at: string;
  payload: string;
}

function rowToActivityEvent(row: ActivityRow): Result<ActivityEvent> {
  try {
    const parsed = activityEventSchema.safeParse({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      source: row.source,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload),
    });
    if (parsed.success) return { ok: true, value: parsed.data };
  } catch {
    /* Malformed JSON is a stored integrity error; never echo payload text. */
  }
  return failure("INTEGRITY_FAILURE", "Stored activity is invalid.");
}

export class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly db: DatabaseConnection) {}
  async get(id: Id): Promise<Result<ActivityEvent | null>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "An activity ID is required.");
    try {
      const row = this.db
        .prepare(
          "SELECT id,session_id,type,source,occurred_at,payload FROM activities WHERE id=?",
        )
        .get(id) as unknown as ActivityRow | undefined;
      return row ? rowToActivityEvent(row) : { ok: true, value: null };
    } catch {
      return failure("INTEGRITY_FAILURE", "Stored activity is unavailable.");
    }
  }

  async append(events: readonly ActivityEvent[]): Promise<Result<void>> {
    const parsed = activityBatchSchema.safeParse(events);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Activity batch is invalid.");
    events = parsed.data;
    if (events.length === 0) {
      return { ok: true, value: undefined };
    }

    let transactionStarted = false;
    try {
      this.db.exec("BEGIN");
      transactionStarted = true;

      const sessionQuery = this.db.prepare(
        "SELECT status, started_at FROM sessions WHERE id = ?",
      );
      for (const event of events) {
        const session = sessionQuery.get(event.sessionId);
        if (
          !session ||
          session.status !== "active" ||
          typeof session.started_at !== "string" ||
          event.occurredAt < session.started_at
        ) {
          this.db.exec("ROLLBACK");
          transactionStarted = false;
          return failure(
            "FORBIDDEN",
            "Activity requires an active matching session.",
          );
        }
        if (event.type === "file-opened")
          writeFileReference(this.db, event.payload);
        if (
          event.type === "file-change" &&
          !this.db
            .prepare("SELECT id FROM files WHERE id = ?")
            .get(event.payload.fileId)
        ) {
          this.db.exec("ROLLBACK");
          transactionStarted = false;
          return failure(
            "NOT_FOUND",
            "Activity file reference is unavailable.",
          );
        }
      }

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
      return failure("INTERNAL", "Failed to append activities.");
    }
  }

  async list(
    sessionId: Id,
    limit: number,
    before?: Timestamp | ActivityCursor,
  ): Promise<Result<ActivityEvent[]>> {
    if (
      !idSchema.safeParse(sessionId).success ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (before !== undefined &&
        !(
          typeof before === "string" ? timestampSchema : activityCursorSchema
        ).safeParse(before).success)
    )
      return failure("INVALID_INPUT", "Activity query is invalid.");
    try {
      let rows: ActivityRow[];

      if (typeof before === "object") {
        rows = this.db
          .prepare(
            `
          SELECT id, session_id, type, source, occurred_at, payload FROM activities
          WHERE session_id = ? AND (occurred_at < ? OR (occurred_at = ? AND id < ?))
          ORDER BY occurred_at DESC, id DESC LIMIT ?
        `,
          )
          .all(
            sessionId,
            before.occurredAt,
            before.occurredAt,
            before.id,
            limit,
          ) as unknown as ActivityRow[];
      } else if (before) {
        const stmt = this.db.prepare(`
          SELECT id, session_id, type, source, occurred_at, payload
          FROM activities
          WHERE session_id = ? AND occurred_at < ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?
        `);
        rows = stmt.all(sessionId, before, limit) as unknown as ActivityRow[];
      } else {
        const stmt = this.db.prepare(`
          SELECT id, session_id, type, source, occurred_at, payload
          FROM activities
          WHERE session_id = ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?
        `);
        rows = stmt.all(sessionId, limit) as unknown as ActivityRow[];
      }

      const activities: ActivityEvent[] = [];
      for (const row of rows) {
        const parsed = rowToActivityEvent(row);
        if (!parsed.ok) return parsed;
        activities.push(parsed.value);
      }
      return { ok: true, value: activities };
    } catch {
      return failure("INTERNAL", "Failed to list activities.");
    }
  }
}
