import { createHash, randomUUID } from "node:crypto";
import {
  failure,
  capturedVersionSummarySchema,
  fileTextCandidateQuerySchema,
  fileTextCandidateSchema,
  fileTextCountsSchema,
  fileTextFormat,
  fileTextHitSchema,
  fileTextQuerySchema,
  fileTextRecordSchema,
  fileTextWriteSchema,
  fileVersionSchema,
  idSchema,
  userSettingsSchema,
  type CapturedVersionSummary,
  type FileTextCandidateQuery,
  type FileTextCandidate,
  type FileTextCounts,
  type FileTextQuery,
  type FileTextRecord,
  type FileTextSearchPage,
  type FileTextWrite,
  type FileVersion,
  type Result,
  type UserSettings,
} from "@rewind/contracts";
import type { DatabaseConnection, SqlValue } from "./database";

const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const eligible = `(v.blob_hash IS NOT NULL AND (v.media_type LIKE 'text/%' OR v.media_type IN ('application/json','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')))`;
const version = (row: Record<string, unknown>): FileVersion =>
  fileVersionSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    fileId: row.file_id,
    capturedAt: row.captured_at,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    mediaType: row.media_type,
  });
function summary(row: Record<string, unknown>): CapturedVersionSummary {
  if (!["verified-path", "unverified"].includes(String(row.identity_kind)))
    throw new Error("FILE_TEXT_REFERENCE_KIND");
  return capturedVersionSummarySchema.parse({
    version: version(row),
    displayName: row.display_name,
    sourceLabel:
      row.identity_kind === "verified-path"
        ? row.absolute_path
        : row.display_name,
  });
}
function record(row: Record<string, unknown>): FileTextRecord {
  if (
    (row.truncated !== 0 && row.truncated !== 1) ||
    (row.state === "unavailable" &&
      (row.text !== null ||
        row.truncated !== 0 ||
        row.pages_read !== null ||
        row.total_pages !== null))
  )
    throw new Error("FILE_TEXT_SHAPE");
  const value = fileTextRecordSchema.parse({
    versionId: row.version_id,
    contentHash: row.content_hash,
    revision: row.revision,
    indexedAt: row.indexed_at,
    textHash: row.text_hash,
    extraction:
      row.state === "available"
        ? {
            state: row.state,
            format: row.format,
            text: row.text,
            truncated: row.truncated === 1,
            pagesRead: row.pages_read,
            totalPages: row.total_pages,
          }
        : { state: row.state, format: row.format, reason: row.issue },
  });
  if (
    value.extraction.state === "available" &&
    (row.issue !== null || digest(value.extraction.text) !== value.textHash)
  )
    throw new Error("FILE_TEXT_INTEGRITY");
  return value;
}
function clip(marked: string, start: string, end: string): string {
  const match = marked.indexOf(start);
  const prefix = marked
    .slice(0, Math.max(0, match))
    .replaceAll(start, "")
    .replaceAll(end, "");
  const value = marked.replaceAll(start, "").replaceAll(end, "");
  if (Buffer.byteLength(value) <= 1000) return value;
  let from = Math.max(0, prefix.length - 150);
  if (
    from &&
    value.charCodeAt(from) >= 0xdc00 &&
    value.charCodeAt(from) <= 0xdfff
  )
    from--;
  const leading = from ? "…" : "";
  const window = value.slice(from);
  const budget = 1000 - Buffer.byteLength(leading);
  if (Buffer.byteLength(window) <= budget) return leading + window;
  let bytes = 0,
    result = "";
  for (const point of window) {
    const size = Buffer.byteLength(point);
    if (bytes + size > budget - 3) break;
    result += point;
    bytes += size;
  }
  return leading + result + "…";
}
export function verifyFileTextSchema(db: DatabaseConnection): void {
  db.prepare(
    "SELECT version_id,content_hash,revision,format,state,text,text_hash,truncated,pages_read,total_pages,issue,indexed_at FROM file_text LIMIT 0",
  ).all();
  db.prepare("SELECT rowid,text FROM file_text_fts LIMIT 0").all();
  const triggers = db
    .prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('file_text_source_insert','file_text_source_update','file_text_fts_insert','file_text_fts_delete','file_text_fts_update')",
    )
    .get();
  if (triggers?.count !== 5) throw new Error("FILE_TEXT_SCHEMA_INCOMPLETE");
  const invalid = db
    .prepare(
      `SELECT 1 FROM file_text t LEFT JOIN file_versions v ON v.id=t.version_id WHERE v.id IS NULL OR v.blob_hash IS NULL OR v.content_hash!=t.content_hash OR t.revision!=1 OR length(t.content_hash)!=64 OR t.content_hash GLOB '*[^a-f0-9]*' OR (t.text_hash IS NOT NULL AND (length(t.text_hash)!=64 OR t.text_hash GLOB '*[^a-f0-9]*')) LIMIT 1`,
    )
    .get();
  if (invalid) throw new Error("FILE_TEXT_SOURCE_INTEGRITY");
}

/** Privileged derived text only; instantiated after cipher/schema verification. No filesystem or provider access. */
export class FileTextRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly physicalBytes: (settings: UserSettings) => number,
  ) {}
  private source(id: string): Result<FileVersion> {
    let bytes: Uint8Array | null = null;
    try {
      const row = this.db
        .prepare(
          "SELECT v.*,b.bytes FROM file_versions v JOIN snapshot_blobs b ON b.content_hash=v.blob_hash WHERE v.id=?",
        )
        .get(id);
      if (!row)
        return failure(
          "NOT_FOUND",
          "Captured source bytes are no longer retained.",
        );
      const source = version(row);
      if (!(row.bytes instanceof Uint8Array))
        throw new Error("FILE_TEXT_SOURCE_BYTES");
      bytes = row.bytes;
      if (
        bytes.length > 16 * 1024 * 1024 ||
        bytes.length !== source.byteLength ||
        digest(bytes) !== source.contentHash
      )
        throw new Error("FILE_TEXT_SOURCE_HASH");
      return { ok: true, value: source };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Captured text source failed integrity verification.",
      );
    } finally {
      bytes?.fill(0);
    }
  }
  async get(id: string): Promise<Result<FileTextRecord | null>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "A captured version ID is required.");
    try {
      const row = this.db
        .prepare("SELECT * FROM file_text WHERE version_id=?")
        .get(id);
      if (!row) return { ok: true, value: null };
      const value = record(row),
        source = this.source(id);
      if (!source.ok) return source;
      if (
        source.value.contentHash !== value.contentHash ||
        fileTextFormat(source.value.mediaType) !== value.extraction.format
      )
        throw new Error("FILE_TEXT_SOURCE_CHANGED");
      return { ok: true, value };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Saved extracted text failed verification.",
      );
    }
  }
  async save(
    input: FileTextWrite,
    authorized: () => boolean,
  ): Promise<Result<{ stored: boolean }>> {
    const parsed = fileTextWriteSchema.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Source-derived text is invalid.");
    if (this.db.isTransaction)
      return failure(
        "CONFLICT",
        "Text indexing requires its own storage transaction.",
      );
    let transaction = false;
    try {
      if (!authorized())
        return failure("FORBIDDEN", "Text indexing authority expired.");
      const value = parsed.data;
      this.db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const source = this.source(value.versionId);
      if (!source.ok) return source;
      if (source.value.contentHash !== value.contentHash)
        return failure(
          "INTEGRITY_FAILURE",
          "The extracted text source hash changed.",
        );
      if (fileTextFormat(source.value.mediaType) !== value.extraction.format)
        return failure(
          "INVALID_INPUT",
          "The extracted format does not match the captured source.",
        );
      const existing = this.db
        .prepare("SELECT * FROM file_text WHERE version_id=?")
        .get(value.versionId);
      if (existing) {
        const previous = record(existing);
        if (previous.contentHash !== value.contentHash)
          return failure("INTEGRITY_FAILURE", "Saved text source changed.");
        if (previous.extraction.state === "available")
          return { ok: true, value: { stored: false } };
      }
      const settings = userSettingsSchema.parse(
        JSON.parse(
          String(
            this.db
              .prepare("SELECT payload FROM runtime_settings WHERE id=1")
              .get()?.payload,
          ),
        ),
      );
      const extraction = value.extraction,
        available = extraction.state === "available";
      const text = available
        ? Buffer.from(extraction.text, "utf8").toString("utf8")
        : null;
      const reserve =
        text === null ? 65536 : Buffer.byteLength(text) * 8 + 65536;
      if (this.physicalBytes(settings) + reserve > settings.storageLimitBytes)
        return failure(
          "STORAGE_LIMIT",
          "The storage quota prevents extracted text indexing.",
        );
      this.db
        .prepare(
          `INSERT INTO file_text(version_id,content_hash,revision,format,state,text,text_hash,truncated,pages_read,total_pages,issue,indexed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(version_id) DO UPDATE SET revision=excluded.revision,format=excluded.format,state=excluded.state,text=excluded.text,text_hash=excluded.text_hash,truncated=excluded.truncated,pages_read=excluded.pages_read,total_pages=excluded.total_pages,issue=excluded.issue,indexed_at=excluded.indexed_at`,
        )
        .run(
          value.versionId,
          value.contentHash,
          value.revision,
          extraction.format,
          extraction.state,
          text,
          text === null ? null : digest(text),
          available && extraction.truncated ? 1 : 0,
          available ? extraction.pagesRead : null,
          available ? extraction.totalPages : null,
          available ? null : extraction.reason,
          value.indexedAt,
        );
      if (!authorized())
        return failure(
          "FORBIDDEN",
          "Text indexing authority changed before commit.",
        );
      this.db.exec("COMMIT");
      transaction = false;
      return { ok: true, value: { stored: true } };
    } catch {
      return failure(
        "UNAVAILABLE",
        "Extracted text could not be stored in encrypted history.",
      );
    } finally {
      if (transaction && this.db.isTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* The failure result keeps this store unavailable to its owner. */
        }
      }
    }
  }
  async next(
    input: FileTextCandidateQuery,
  ): Promise<Result<FileTextCandidate | null>> {
    const parsed = fileTextCandidateQuerySchema.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "The text indexing scope is invalid.");
    const query = parsed.data;
    if (query.folderIds?.length === 0) return { ok: true, value: null };
    try {
      const clauses = [
          eligible,
          "v.captured_at<=?",
          query.retryFailures
            ? "(t.version_id IS NULL OR t.state='unavailable')"
            : "t.version_id IS NULL",
        ],
        args: SqlValue[] = [query.through];
      if (query.after) {
        clauses.push("(v.captured_at>? OR (v.captured_at=? AND v.id>?))");
        args.push(
          query.after.capturedAt,
          query.after.capturedAt,
          query.after.id,
        );
      }
      if (query.sessionId) {
        clauses.push("v.session_id=?");
        args.push(query.sessionId);
      }
      if (query.folderIds) {
        clauses.push(
          `fb.folder_id IN (${query.folderIds.map(() => "?").join(",")})`,
        );
        args.push(...query.folderIds);
      }
      const row = this.db
        .prepare(
          `SELECT v.*,f.display_name,f.identity_kind,f.absolute_path,fb.folder_id FROM file_versions v JOIN snapshot_blobs b ON b.content_hash=v.blob_hash JOIN files f ON f.id=v.file_id LEFT JOIN file_text t ON t.version_id=v.id LEFT JOIN file_bindings fb ON fb.file_id=v.file_id WHERE ${clauses.join(" AND ")} ORDER BY v.captured_at,v.id LIMIT 1`,
        )
        .get(...args);
      if (!row) return { ok: true, value: null };
      const value = fileTextCandidateSchema.parse({
        ...summary(row),
        folderId: row.folder_id ?? null,
      });
      return { ok: true, value };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "The retained indexing scope could not be verified.",
      );
    }
  }
  async candidate(id: string): Promise<Result<FileTextCandidate | null>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "A captured version ID is required.");
    try {
      const row = this.db
        .prepare(
          "SELECT v.*,f.display_name,f.identity_kind,f.absolute_path,fb.folder_id FROM file_versions v JOIN snapshot_blobs b ON b.content_hash=v.blob_hash JOIN files f ON f.id=v.file_id LEFT JOIN file_bindings fb ON fb.file_id=v.file_id WHERE v.id=?",
        )
        .get(id);
      return {
        ok: true,
        value: row
          ? fileTextCandidateSchema.parse({
              ...summary(row),
              folderId: row.folder_id ?? null,
            })
          : null,
      };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "The captured text source identity could not be verified.",
      );
    }
  }
  async counts(): Promise<Result<FileTextCounts>> {
    try {
      const row = this.db
        .prepare(
          `SELECT count(*) AS eligible,coalesce(sum(t.state='available'),0) AS indexed,coalesce(sum(t.state='unavailable'),0) AS unavailable,coalesce(sum(t.version_id IS NULL),0) AS pending FROM file_versions v LEFT JOIN file_text t ON t.version_id=v.id WHERE ${eligible}`,
        )
        .get();
      return { ok: true, value: fileTextCountsSchema.parse(row) };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Extracted text counts could not be verified.",
      );
    }
  }
  async search(
    input: FileTextQuery,
    allowed: (source: CapturedVersionSummary) => boolean = () => true,
  ): Promise<Result<FileTextSearchPage>> {
    const parsed = fileTextQuerySchema.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "The captured-content query is invalid.");
    const query = parsed.data,
      terms = query.text.split(/\s+/);
    if (terms.length > 30)
      return failure("INVALID_INPUT", "Use at most 30 search terms.");
    try {
      const marker = randomUUID(),
        start = `[rewind-${marker}-start]`,
        end = `[rewind-${marker}-end]`;
      const clauses = [
          "file_text_fts MATCH ?",
          "t.state='available'",
          "t.content_hash=v.content_hash",
          "v.blob_hash=v.content_hash",
        ],
        args: SqlValue[] = [
          start,
          end,
          terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "),
        ];
      if (query.sessionId) {
        clauses.push("v.session_id=?");
        args.push(query.sessionId);
      }
      if (query.from) {
        clauses.push("v.captured_at>=?");
        args.push(query.from);
      }
      if (query.to) {
        clauses.push("v.captured_at<=?");
        args.push(query.to);
      }
      if (query.before) {
        clauses.push("(v.captured_at<? OR (v.captured_at=? AND v.id<?))");
        args.push(
          query.before.capturedAt,
          query.before.capturedAt,
          query.before.id,
        );
      }
      args.push(query.limit + 1);
      const rows = this.db
        .prepare(
          `SELECT v.*,f.display_name,f.identity_kind,f.absolute_path,snippet(file_text_fts,0,?,?,' … ',24) AS excerpt FROM file_text_fts JOIN file_text t ON t.rowid=file_text_fts.rowid JOIN file_versions v ON v.id=t.version_id JOIN files f ON f.id=v.file_id WHERE ${clauses.join(" AND ")} ORDER BY v.captured_at DESC,v.id DESC LIMIT ?`,
        )
        .all(...args) as Record<string, unknown>[];
      const hits = [];
      for (const row of rows.slice(0, query.limit)) {
        const source = summary(row);
        if (!allowed(source)) continue;
        const read = await this.get(String(row.id));
        if (!read.ok) return read;
        if (
          read.value?.extraction.state !== "available" ||
          typeof row.excerpt !== "string"
        )
          return failure(
            "INTEGRITY_FAILURE",
            "The matched captured text is no longer verified.",
          );
        hits.push(
          fileTextHitSchema.parse({
            ...source,
            snippet: clip(row.excerpt, start, end),
            format: read.value.extraction.format,
            truncated: read.value.extraction.truncated,
          }),
        );
      }
      const hasMore = rows.length > query.limit,
        last = rows[query.limit - 1];
      return {
        ok: true,
        value: {
          hits,
          hasMore,
          ...(hasMore && last
            ? {
                nextBefore: {
                  capturedAt: String(last.captured_at),
                  id: String(last.id),
                },
              }
            : {}),
        },
      };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Captured-content search could not be verified.",
      );
    }
  }
}
