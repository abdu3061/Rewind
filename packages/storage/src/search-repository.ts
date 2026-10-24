import { DatabaseSync } from 'node:sqlite';
import {
  failure,
  type Result,
  type SearchQuery,
  type SearchRepository,
  type SearchResult,
} from '@rewind/contracts';

interface ActivitySearchRow {
  id: string;
  session_id: string;
  type: string;
  occurred_at: string;
  payload: string;
}

interface FileSearchRow {
  id: string;
  display_name: string;
  identity_kind: 'verified-path' | 'unverified';
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
    try {
      const results: SearchResult[] = [];
      const term = query.text.trim();

      if (!term) {
        return { ok: true, value: [] };
      }

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

      const actRows = this.db.prepare(actSql).all(...actParams) as unknown as ActivitySearchRow[];

      for (const row of actRows) {
        let title = `Activity: ${row.type}`;
        try {
          const parsed = JSON.parse(row.payload);
          if (parsed.windowTitle) title = String(parsed.windowTitle);
          else if (parsed.application) title = String(parsed.application);
        } catch {
          // fallback to default title
        }

        results.push({
          source: { kind: 'activity', activityId: row.id },
          occurredAt: row.occurred_at,
          title,
          excerpt: row.payload.slice(0, 300),
          evidence: 'recorded',
        });
      }

      // 2. Search Files (matching display name or path)
      const fileSql = `
        SELECT id, display_name, identity_kind, absolute_path, verified_at, observed_title
        FROM files
        WHERE display_name LIKE '%' || ? || '%'
           OR (absolute_path IS NOT NULL AND absolute_path LIKE '%' || ? || '%')
           OR (observed_title IS NOT NULL AND observed_title LIKE '%' || ? || '%')
        LIMIT ?
      `;
      const fileRows = this.db
        .prepare(fileSql)
        .all(term, term, term, query.limit) as unknown as FileSearchRow[];

      for (const row of fileRows) {
        const isVerified = row.identity_kind === 'verified-path';
        results.push({
          source: {
            kind: 'file-version',
            fileId: row.id,
            fileVersionId: row.id, // reference fallback
          },
          occurredAt: row.verified_at ?? new Date(0).toISOString(),
          title: row.display_name,
          excerpt: isVerified ? (row.absolute_path ?? '') : (row.observed_title ?? ''),
          evidence: isVerified ? 'verified-path' : 'title-only',
        });
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
      cpSql += ` ORDER BY created_at DESC LIMIT ?`;
      cpParams.push(query.limit);

      const cpRows = this.db.prepare(cpSql).all(...cpParams) as unknown as CheckpointSearchRow[];

      for (const row of cpRows) {
        results.push({
          source: { kind: 'checkpoint', checkpointId: row.id },
          occurredAt: row.created_at,
          title: `Checkpoint: ${row.name}`,
          excerpt: `Named milestone: ${row.name}`,
          evidence: 'recorded',
        });
      }

      // Sort all combined results by occurredAt DESC and apply limit
      results.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      const sliced = results.slice(0, query.limit);

      return { ok: true, value: sliced };
    } catch (error) {
      return failure(
        'INTERNAL',
        `Failed to execute search: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
