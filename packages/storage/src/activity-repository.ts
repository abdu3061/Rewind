import { DatabaseSync } from "node:sqlite";
import {
  activityEventSchema,
  failure,
  idSchema,
  timestampSchema,
  type ActivityEvent,
  type ActivityRepository,
  type ActivityType,
  type Id,
  type Result,
  type TimelineQueryOptions,
  type TimelineSummary,
  type Timestamp,
} from "@rewind/contracts";

interface ActivityRow {
  id: string;
  session_id: string;
  type: ActivityEvent["type"];
  source: ActivityEvent["source"];
  occurred_at: string;
  payload: string;
}

function rowToActivityEvent(row: ActivityRow): Result<ActivityEvent> {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(row.payload);
  } catch (error) {
    return failure(
      "INTEGRITY_FAILURE",
      `Malformed activity payload JSON in record ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const candidate = {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    source: row.source,
    occurredAt: row.occurred_at,
    payload: parsedPayload,
  };

  const parsed = activityEventSchema.safeParse(candidate);
  if (!parsed.success) {
    return failure(
      "INTEGRITY_FAILURE",
      `Corrupted activity event ${row.id}: ${parsed.error.issues[0]?.message ?? "Schema mismatch"}`,
    );
  }

  return { ok: true, value: parsed.data };
}

export class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly db: DatabaseSync) {}

  async append(events: readonly ActivityEvent[]): Promise<Result<void>> {
    if (events.length === 0) {
      return { ok: true, value: undefined };
    }

    // 1. Validate all events before touching the database
    for (const event of events) {
      const parsed = activityEventSchema.safeParse(event);
      if (!parsed.success) {
        return failure(
          "INVALID_INPUT",
          `Invalid activity event (${event.id ?? "unknown"}): ${parsed.error.issues[0]?.message ?? "Validation failed"}`,
        );
      }
    }

    try {
      this.db.exec("BEGIN IMMEDIATE");

      const checkSessionStmt = this.db.prepare(
        "SELECT id FROM sessions WHERE id = ?",
      );

      // Verify session exists for foreign key integrity
      const checkedSessions = new Set<string>();
      for (const event of events) {
        if (!checkedSessions.has(event.sessionId)) {
          const sessionRow = checkSessionStmt.get(event.sessionId);
          if (!sessionRow) {
            this.db.exec("ROLLBACK");
            return failure(
              "NOT_FOUND",
              `Referenced session ${event.sessionId} does not exist.`,
            );
          }
          checkedSessions.add(event.sessionId);
        }
      }

      const stmt = this.db.prepare(`
        INSERT INTO activities (id, session_id, type, source, occurred_at, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
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
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Safe rollback ignore if transaction already rolled back
      }
      return failure(
        "INTERNAL",
        `Failed to append activities: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async list(
    sessionId: Id,
    limit: number,
    before?: Timestamp,
  ): Promise<Result<ActivityEvent[]>> {
    const validSessionId = idSchema.safeParse(sessionId);
    if (!validSessionId.success) {
      return failure("INVALID_INPUT", `Invalid session id: ${sessionId}`);
    }

    if (limit <= 0) {
      return failure("INVALID_INPUT", "Limit must be a positive number.");
    }

    if (before) {
      const validBefore = timestampSchema.safeParse(before);
      if (!validBefore.success) {
        return failure("INVALID_INPUT", `Invalid before timestamp: ${before}`);
      }
    }

    return this.queryTimeline({
      sessionId,
      limit,
      ...(before !== undefined ? { before } : {}),
      order: "desc",
    });
  }

  async queryTimeline(
    options: TimelineQueryOptions,
  ): Promise<Result<ActivityEvent[]>> {
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

    if (options.types && options.types.length > 0) {
      const placeholders = options.types.map(() => "?").join(", ");
      conditions.push(`type IN (${placeholders})`);
      params.push(...options.types);
    }

    if (options.source) {
      conditions.push("source = ?");
      params.push(options.source);
    }

    if (options.after) {
      const validAfter = timestampSchema.safeParse(options.after);
      if (!validAfter.success) {
        return failure(
          "INVALID_INPUT",
          `Invalid after timestamp: ${options.after}`,
        );
      }
      conditions.push("occurred_at > ?");
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
      conditions.push("occurred_at < ?");
      params.push(options.before);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderDirection =
      options.order?.toLowerCase() === "asc" ? "ASC" : "DESC";
    const limitCount = Math.min(Math.max(options.limit ?? 50, 1), 500);

    const sql = `
      SELECT id, session_id, type, source, occurred_at, payload
      FROM activities
      ${whereClause}
      ORDER BY occurred_at ${orderDirection}
      LIMIT ?
    `;
    params.push(limitCount);

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as unknown as ActivityRow[];

      const events: ActivityEvent[] = [];
      for (const row of rows) {
        const result = rowToActivityEvent(row);
        if (!result.ok) return result;
        events.push(result.value);
      }

      return { ok: true, value: events };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to query timeline: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async count(sessionId: Id, type?: ActivityType): Promise<Result<number>> {
    const validSessionId = idSchema.safeParse(sessionId);
    if (!validSessionId.success) {
      return failure("INVALID_INPUT", `Invalid session id: ${sessionId}`);
    }

    try {
      let sql = "SELECT COUNT(*) as count FROM activities WHERE session_id = ?";
      const params: (string | number)[] = [sessionId];
      if (type) {
        sql += " AND type = ?";
        params.push(type);
      }

      const stmt = this.db.prepare(sql);
      const row = stmt.get(...params) as unknown as { count: number };
      return { ok: true, value: row?.count ?? 0 };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to count activities: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getTimelineSummary(sessionId: Id): Promise<Result<TimelineSummary>> {
    const validSessionId = idSchema.safeParse(sessionId);
    if (!validSessionId.success) {
      return failure("INVALID_INPUT", `Invalid session id: ${sessionId}`);
    }

    try {
      const totalStmt = this.db.prepare(`
        SELECT COUNT(*) as total, MIN(occurred_at) as first_at, MAX(occurred_at) as last_at
        FROM activities
        WHERE session_id = ?
      `);
      const totalRow = totalStmt.get(sessionId) as unknown as {
        total: number;
        first_at: string | null;
        last_at: string | null;
      };

      const groupStmt = this.db.prepare(`
        SELECT type, COUNT(*) as count
        FROM activities
        WHERE session_id = ?
        GROUP BY type
      `);
      const groupRows = groupStmt.all(sessionId) as unknown as {
        type: ActivityType;
        count: number;
      }[];

      const eventsByType: Partial<Record<ActivityType, number>> = {};
      for (const r of groupRows) {
        eventsByType[r.type] = r.count;
      }

      return {
        ok: true,
        value: {
          sessionId,
          totalEvents: totalRow?.total ?? 0,
          eventsByType,
          firstEventAt: totalRow?.first_at ?? null,
          lastEventAt: totalRow?.last_at ?? null,
        },
      };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get timeline summary: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
