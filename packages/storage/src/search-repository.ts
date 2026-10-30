import { DatabaseSync } from "node:sqlite";
import {
  failure,
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
  occurred_at: string;
  payload: string;
}

interface FileVersionSearchRow {
  file_id: string;
  version_id: string;
  display_name: string;
  identity_kind: "verified-path" | "unverified";
  absolute_path: string | null;
  observed_title: string | null;
  captured_at: string;
  media_type: string;
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
    if (!parsedQuery.success) {
      return failure(
        "INVALID_INPUT",
        `Invalid search query: ${parsedQuery.error.issues[0]?.message ?? "Validation failed"}`,
      );
    }

    try {
      const term = query.text.trim();
      if (!term) {
        return { ok: true, value: [] };
      }

      const results: SearchResult[] = [];

      // 1. Search Activities (matching payload text)
      let actSql = `
        SELECT id, session_id, type, occurred_at, payload
        FROM activities
        WHERE payload LIKE '%' || ? || '%'
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
      actSql += ` ORDER BY occurred_at DESC LIMIT ?`;
      actParams.push(query.limit);

      const actRows = this.db
        .prepare(actSql)
        .all(...actParams) as unknown as ActivitySearchRow[];

      for (const row of actRows) {
        let title = `Activity: ${row.type}`;
        let browserVisitId: string | null = null;
        try {
          const parsed = JSON.parse(row.payload);
          if (row.type === "browser-visit" && parsed.id) {
            browserVisitId = String(parsed.id);
            if (parsed.title) title = String(parsed.title);
            else if (parsed.url) title = String(parsed.url);
          } else if (parsed.windowTitle) {
            title = String(parsed.windowTitle);
          } else if (parsed.application) {
            title = String(parsed.application);
          } else if (parsed.displayName) {
            title = String(parsed.displayName);
          }
        } catch {
          // Keep fallback title
        }

        const candidateResult: SearchResult = {
          source: browserVisitId
            ? { kind: "browser-visit", browserVisitId }
            : { kind: "activity", activityId: row.id },
          occurredAt: row.occurred_at,
          title: title.slice(0, 2048),
          excerpt: row.payload.slice(0, 300),
          evidence: "recorded",
        };

        const parsedResult = searchResultSchema.safeParse(candidateResult);
        if (parsedResult.success) {
          results.push(parsedResult.data);
        }
      }

      // 2. Search Files (matching display name, path, or observed title)
      let fileSql = `
        SELECT 
          f.id as file_id,
          COALESCE(fv.id, f.id) as version_id,
          f.display_name,
          f.identity_kind,
          f.absolute_path,
          f.observed_title,
          COALESCE(fv.captured_at, f.verified_at, '2026-01-01T00:00:00.000Z') as captured_at,
          COALESCE(fv.media_type, 'application/octet-stream') as media_type
        FROM files f
        LEFT JOIN (
          SELECT id, file_id, captured_at, media_type, session_id
          FROM file_versions
          WHERE (file_id, captured_at) IN (
            SELECT file_id, MAX(captured_at) FROM file_versions GROUP BY file_id
          )
        ) fv ON f.id = fv.file_id
        WHERE (
          f.display_name LIKE '%' || ? || '%'
          OR (f.absolute_path IS NOT NULL AND f.absolute_path LIKE '%' || ? || '%')
          OR (f.observed_title IS NOT NULL AND f.observed_title LIKE '%' || ? || '%')
        )
      `;
      const fileParams: (string | number)[] = [term, term, term];

      if (query.sessionId) {
        fileSql += ` AND (fv.session_id = ? OR fv.session_id IS NULL)`;
        fileParams.push(query.sessionId);
      }
      if (query.from) {
        fileSql += ` AND COALESCE(fv.captured_at, f.verified_at, '2026-01-01T00:00:00.000Z') >= ?`;
        fileParams.push(query.from);
      }
      if (query.to) {
        fileSql += ` AND COALESCE(fv.captured_at, f.verified_at, '2026-01-01T00:00:00.000Z') <= ?`;
        fileParams.push(query.to);
      }
      fileSql += ` ORDER BY captured_at DESC LIMIT ?`;
      fileParams.push(query.limit);

      const fileRows = this.db
        .prepare(fileSql)
        .all(...fileParams) as unknown as FileVersionSearchRow[];

      for (const row of fileRows) {
        const isVerified = row.identity_kind === "verified-path";
        const excerpt = isVerified
          ? (row.absolute_path ?? row.display_name)
          : (row.observed_title ?? row.display_name);

        const candidateResult: SearchResult = {
          source: {
            kind: "file-version",
            fileId: row.file_id,
            fileVersionId: row.version_id,
          },
          occurredAt: row.captured_at,
          title: row.display_name.slice(0, 2048),
          excerpt: excerpt.slice(0, 4000),
          evidence: isVerified ? "verified-path" : "title-only",
        };

        const parsedResult = searchResultSchema.safeParse(candidateResult);
        if (parsedResult.success) {
          results.push(parsedResult.data);
        }
      }

      // 3. Search Checkpoints (matching checkpoint name)
      let cpSql = `
        SELECT id, session_id, name, created_at
        FROM checkpoints
        WHERE name LIKE '%' || ? || '%'
      `;
      const cpParams: (string | number)[] = [term];

      if (query.sessionId) {
        cpSql += ` AND session_id = ?`;
        cpParams.push(query.sessionId);
      }
      if (query.from) {
        cpSql += ` AND created_at >= ?`;
        cpParams.push(query.from);
      }
      if (query.to) {
        cpSql += ` AND created_at <= ?`;
        cpParams.push(query.to);
      }
      cpSql += ` ORDER BY created_at DESC LIMIT ?`;
      cpParams.push(query.limit);

      const cpRows = this.db
        .prepare(cpSql)
        .all(...cpParams) as unknown as CheckpointSearchRow[];

      for (const row of cpRows) {
        const candidateResult: SearchResult = {
          source: { kind: "checkpoint", checkpointId: row.id },
          occurredAt: row.created_at,
          title: `Checkpoint: ${row.name}`.slice(0, 2048),
          excerpt: `Named milestone: ${row.name}`.slice(0, 4000),
          evidence: "recorded",
        };

        const parsedResult = searchResultSchema.safeParse(candidateResult);
        if (parsedResult.success) {
          results.push(parsedResult.data);
        }
      }

      // Sort combined results by occurredAt DESC and apply limit
      results.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      const sliced = results.slice(0, query.limit);

      return { ok: true, value: sliced };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to execute search: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
