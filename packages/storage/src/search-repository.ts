import { DatabaseSync } from "node:sqlite";
import {
  failure,
  activityEventSchema,
  searchQuerySchema,
  searchResultSchema,
  type Result,
  type SearchQuery,
  type SearchRepository,
  type SearchResult,
} from "@rewind/contracts";

interface ActivitySearchRow {
  id: string;
  session_id: string;
  type: string;
  source: string;
  occurred_at: string;
  payload: string;
}

interface FileSearchRow {
  id: string;
  version_id: string;
  captured_at: string;
  display_name: string;
  identity_kind: "verified-path" | "unverified";
  absolute_path: string | null;
  verified_at: string | null;
  observed_title: string | null;
}

interface CheckpointSearchRow {
  id: string;
  session_id: string;
  name: string;
  created_at: string;
}

export class SqliteSearchRepository implements SearchRepository {
  constructor(private readonly db: DatabaseSync) {}

  async search(query: SearchQuery): Promise<Result<SearchResult[]>> {
    const parsedQuery = searchQuerySchema.safeParse(query);
    if (!parsedQuery.success)
      return failure("INVALID_INPUT", "Search query is invalid.");
    query = parsedQuery.data;
    if (query.mode !== "keyword")
      return failure("NOT_IMPLEMENTED", "Only keyword search is available.");
    try {
      const results: SearchResult[] = [];
      const term = query.text.replace(/[\\%_]/g, "\\$&");

      if (!term) {
        return { ok: true, value: [] };
      }

      // 1. Search Activities (matching payload text)
      let actSql = `
        SELECT id, session_id, type, source, occurred_at, payload
        FROM activities
        WHERE payload LIKE '%' || ? || '%' ESCAPE '\\'
      `;
      const actParams: (string | number)[] = [term];

      if (query.sessionId) {
        actSql += ` AND session_id = ?`;
        actParams.push(query.sessionId);
      }
      if (query.from) {
        actSql += ` AND occurred_at >= ?`;
        actParams.push(query.from);
      }
      if (query.to) {
        actSql += ` AND occurred_at <= ?`;
        actParams.push(query.to);
      }
      actSql += ` ORDER BY occurred_at DESC, id DESC LIMIT ?`;
      actParams.push(query.limit);

      const actRows = this.db
        .prepare(actSql)
        .all(...actParams) as unknown as ActivitySearchRow[];

      for (const row of actRows) {
        let title = `Activity: ${row.type}`;
        try {
          const parsed = activityEventSchema.safeParse({
            id: row.id,
            sessionId: row.session_id,
            type: row.type,
            source: row.source,
            occurredAt: row.occurred_at,
            payload: JSON.parse(row.payload),
          });
          if (!parsed.success)
            return failure(
              "INTEGRITY_FAILURE",
              "Stored search evidence is invalid.",
            );
          const event = parsed.data;
          if (event.type === "foreground")
            title = event.payload.windowTitle || event.payload.application;
          else if (event.type === "browser-visit") title = event.payload.title;
          else if (event.type === "file-opened")
            title = event.payload.displayName;
        } catch {
          return failure(
            "INTEGRITY_FAILURE",
            "Stored search evidence is invalid.",
          );
        }

        results.push({
          source: { kind: "activity", activityId: row.id },
          occurredAt: row.occurred_at,
          title,
          excerpt: title.slice(0, 300),
          evidence: "recorded",
        });
      }

      // 2. Search Files (matching display name or path)
      let scope = "1 = 1";
      const fileParams: (string | number)[] = [];
      if (query.sessionId) {
        scope += " AND session_id = ?";
        fileParams.push(query.sessionId);
      }
      if (query.from) {
        scope += " AND captured_at >= ?";
        fileParams.push(query.from);
      }
      if (query.to) {
        scope += " AND captured_at <= ?";
        fileParams.push(query.to);
      }
      const fileSql = `
        WITH scoped AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY captured_at DESC, id DESC) AS position
          FROM file_versions WHERE ${scope}
        )
        SELECT f.*, fv.id AS version_id, fv.captured_at FROM files f
        JOIN scoped fv ON fv.file_id = f.id AND fv.position = 1
        WHERE (display_name LIKE '%' || ? || '%' ESCAPE '\\'
           OR absolute_path LIKE '%' || ? || '%' ESCAPE '\\'
           OR observed_title LIKE '%' || ? || '%' ESCAPE '\\')
        ORDER BY fv.captured_at DESC, fv.id DESC LIMIT ?`;
      fileParams.push(term, term, term, query.limit);
      const fileRows = this.db
        .prepare(fileSql)
        .all(...fileParams) as unknown as FileSearchRow[];

      for (const row of fileRows) {
        const isVerified = row.identity_kind === "verified-path";
        results.push({
          source: {
            kind: "file-version",
            fileId: row.id,
            fileVersionId: row.version_id,
          },
          occurredAt: row.captured_at,
          title: row.display_name,
          excerpt: isVerified
            ? (row.absolute_path ?? "").slice(0, 4000)
            : (row.observed_title ?? "").slice(0, 4000),
          evidence: isVerified ? "verified-path" : "title-only",
        });
      }

      // 3. Search Checkpoints (matching checkpoint name)
      let cpSql = `
        SELECT id, session_id, name, created_at
        FROM checkpoints
        WHERE name LIKE '%' || ? || '%' ESCAPE '\\'
      `;
      const cpParams: (string | number)[] = [term];
      if (query.sessionId) {
        cpSql += ` AND session_id = ?`;
        cpParams.push(query.sessionId);
      }
      if (query.from) {
        cpSql += " AND created_at >= ?";
        cpParams.push(query.from);
      }
      if (query.to) {
        cpSql += " AND created_at <= ?";
        cpParams.push(query.to);
      }
      cpSql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
      cpParams.push(query.limit);

      const cpRows = this.db
        .prepare(cpSql)
        .all(...cpParams) as unknown as CheckpointSearchRow[];

      for (const row of cpRows) {
        results.push({
          source: { kind: "checkpoint", checkpointId: row.id },
          occurredAt: row.created_at,
          title: `Checkpoint: ${row.name}`,
          excerpt: `Named milestone: ${row.name}`,
          evidence: "recorded",
        });
      }

      // Sort all combined results by occurredAt DESC and apply limit
      results.sort((a, b) => {
        const left = `${a.occurredAt}:${JSON.stringify(a.source)}`;
        const right = `${b.occurredAt}:${JSON.stringify(b.source)}`;
        return left === right ? 0 : left < right ? 1 : -1;
      });
      const sliced = results.slice(0, query.limit);
      if (
        sliced.some((result) => !searchResultSchema.safeParse(result).success)
      )
        return failure(
          "INTEGRITY_FAILURE",
          "Stored search evidence is invalid.",
        );

      return { ok: true, value: sliced };
    } catch {
      return failure("INTERNAL", "Failed to execute search.");
    }
  }
}
