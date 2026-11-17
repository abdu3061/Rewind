import { DatabaseSync } from "node:sqlite";
import {
  failure,
  fileReferenceSchema,
  fileVersionSchema,
  idSchema,
  timestampSchema,
  type FileReference,
  type FileRepository,
  type FileVersion,
  type FileVersionQueryOptions,
  type Id,
  type Result,
} from "@rewind/contracts";

interface FileRow {
  id: string;
  display_name: string;
  identity_kind: "verified-path" | "unverified";
  absolute_path: string | null;
  verified_at: string | null;
  observed_title: string | null;
}

interface FileVersionRow {
  id: string;
  session_id: string;
  file_id: string;
  captured_at: string;
  content_hash: string;
  byte_length: number;
  media_type: string;
}

function rowToFileReference(row: FileRow): Result<FileReference> {
  const candidate =
    row.identity_kind === "verified-path"
      ? {
          id: row.id,
          displayName: row.display_name,
          identity: {
            kind: "verified-path" as const,
            absolutePath: row.absolute_path ?? "",
            verifiedAt: row.verified_at ?? "",
          },
        }
      : {
          id: row.id,
          displayName: row.display_name,
          identity: {
            kind: "unverified" as const,
            observedTitle: row.observed_title ?? "",
          },
        };

  const parsed = fileReferenceSchema.safeParse(candidate);
  if (!parsed.success) {
    return failure(
      "INTEGRITY_FAILURE",
      `Corrupted file reference record ${row.id}: ${parsed.error.issues[0]?.message ?? "Schema mismatch"}`,
    );
  }

  return { ok: true, value: parsed.data };
}

function rowToFileVersion(row: FileVersionRow): Result<FileVersion> {
  const candidate = {
    id: row.id,
    sessionId: row.session_id,
    fileId: row.file_id,
    capturedAt: row.captured_at,
    contentHash: row.content_hash,
    byteLength: Number(row.byte_length),
    mediaType: row.media_type,
  };

  const parsed = fileVersionSchema.safeParse(candidate);
  if (!parsed.success) {
    return failure(
      "INTEGRITY_FAILURE",
      `Corrupted file version record ${row.id}: ${parsed.error.issues[0]?.message ?? "Schema mismatch"}`,
    );
  }

  return { ok: true, value: parsed.data };
}

export class SqliteFileRepository implements FileRepository {
  constructor(private readonly db: DatabaseSync) {}

  async saveReference(file: FileReference): Promise<Result<void>> {
    const parsed = fileReferenceSchema.safeParse(file);
    if (!parsed.success) {
      return failure(
        "INVALID_INPUT",
        `Invalid file reference: ${parsed.error.issues[0]?.message ?? "Validation failed"}`,
      );
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO files (id, display_name, identity_kind, absolute_path, verified_at, observed_title)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          identity_kind = excluded.identity_kind,
          absolute_path = excluded.absolute_path,
          verified_at = excluded.verified_at,
          observed_title = excluded.observed_title
      `);

      let absPath: string | null = null;
      let verAt: string | null = null;
      let obsTitle: string | null = null;

      if (file.identity.kind === "verified-path") {
        absPath = file.identity.absolutePath;
        verAt = file.identity.verifiedAt;
      } else {
        obsTitle = file.identity.observedTitle;
      }

      stmt.run(
        file.id,
        file.displayName,
        file.identity.kind,
        absPath,
        verAt,
        obsTitle,
      );

      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to save file reference: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getReference(fileId: Id): Promise<Result<FileReference | null>> {
    const validId = idSchema.safeParse(fileId);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid file id: ${fileId}`);
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, display_name, identity_kind, absolute_path, verified_at, observed_title
        FROM files
        WHERE id = ?
      `);

      const row = stmt.get(fileId) as unknown as FileRow | undefined;
      if (!row) {
        return { ok: true, value: null };
      }

      return rowToFileReference(row);
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get file reference: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async addVersion(version: FileVersion): Promise<Result<void>> {
    const parsed = fileVersionSchema.safeParse(version);
    if (!parsed.success) {
      return failure(
        "INVALID_INPUT",
        `Invalid file version: ${parsed.error.issues[0]?.message ?? "Validation failed"}`,
      );
    }

    try {
      // 1. Verify referenced file exists
      const fileCheck = this.db.prepare("SELECT id FROM files WHERE id = ?");
      if (!fileCheck.get(version.fileId)) {
        return failure(
          "NOT_FOUND",
          `Referenced file ${version.fileId} does not exist.`,
        );
      }

      // 2. Verify referenced session exists
      const sessionCheck = this.db.prepare(
        "SELECT id FROM sessions WHERE id = ?",
      );
      if (!sessionCheck.get(version.sessionId)) {
        return failure(
          "NOT_FOUND",
          `Referenced session ${version.sessionId} does not exist.`,
        );
      }

      // 3. Verify version does not already conflict with different attributes
      const existingCheck = this.db.prepare(
        "SELECT id FROM file_versions WHERE id = ?",
      );
      if (existingCheck.get(version.id)) {
        return failure(
          "CONFLICT",
          `File version with id ${version.id} already exists.`,
        );
      }

      const stmt = this.db.prepare(`
        INSERT INTO file_versions (id, session_id, file_id, captured_at, content_hash, byte_length, media_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        version.id,
        version.sessionId,
        version.fileId,
        version.capturedAt,
        version.contentHash,
        version.byteLength,
        version.mediaType,
      );

      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to add file version: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getVersion(id: Id): Promise<Result<FileVersion | null>> {
    const validId = idSchema.safeParse(id);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid version id: ${id}`);
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type
        FROM file_versions
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as FileVersionRow | undefined;
      if (!row) {
        return { ok: true, value: null };
      }

      return rowToFileVersion(row);
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get file version: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listVersions(
    fileId: Id,
    limit: number = 100,
  ): Promise<Result<FileVersion[]>> {
    const validId = idSchema.safeParse(fileId);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid file id: ${fileId}`);
    }

    return this.queryVersions({
      fileId,
      limit,
      order: "desc",
    });
  }

  async getLatestVersion(fileId: Id): Promise<Result<FileVersion | null>> {
    const validId = idSchema.safeParse(fileId);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid file id: ${fileId}`);
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type
        FROM file_versions
        WHERE file_id = ?
        ORDER BY captured_at DESC
        LIMIT 1
      `);

      const row = stmt.get(fileId) as unknown as FileVersionRow | undefined;
      if (!row) {
        return { ok: true, value: null };
      }

      return rowToFileVersion(row);
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to get latest file version: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listVersionsBySession(
    sessionId: Id,
    limit: number = 100,
  ): Promise<Result<FileVersion[]>> {
    const validId = idSchema.safeParse(sessionId);
    if (!validId.success) {
      return failure("INVALID_INPUT", `Invalid session id: ${sessionId}`);
    }

    return this.queryVersions({
      sessionId,
      limit,
      order: "desc",
    });
  }

  async listReferences(limit: number = 100): Promise<Result<FileReference[]>> {
    if (limit <= 0) {
      return failure("INVALID_INPUT", "Limit must be a positive number.");
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, display_name, identity_kind, absolute_path, verified_at, observed_title
        FROM files
        ORDER BY display_name ASC
        LIMIT ?
      `);

      const rows = stmt.all(limit) as unknown as FileRow[];
      const references: FileReference[] = [];
      for (const row of rows) {
        const result = rowToFileReference(row);
        if (!result.ok) return result;
        references.push(result.value);
      }

      return { ok: true, value: references };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to list file references: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async queryVersions(
    options: FileVersionQueryOptions,
  ): Promise<Result<FileVersion[]>> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.fileId) {
      const validId = idSchema.safeParse(options.fileId);
      if (!validId.success) {
        return failure("INVALID_INPUT", `Invalid file id: ${options.fileId}`);
      }
      conditions.push("file_id = ?");
      params.push(options.fileId);
    }

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

    if (options.mediaType) {
      conditions.push("media_type = ?");
      params.push(options.mediaType);
    }

    if (options.after) {
      const validAfter = timestampSchema.safeParse(options.after);
      if (!validAfter.success) {
        return failure(
          "INVALID_INPUT",
          `Invalid after timestamp: ${options.after}`,
        );
      }
      conditions.push("captured_at > ?");
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
      conditions.push("captured_at < ?");
      params.push(options.before);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderDirection =
      options.order?.toLowerCase() === "asc" ? "ASC" : "DESC";
    const limitCount = Math.min(Math.max(options.limit ?? 100, 1), 500);

    const sql = `
      SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type
      FROM file_versions
      ${whereClause}
      ORDER BY captured_at ${orderDirection}
      LIMIT ?
    `;
    params.push(limitCount);

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as unknown as FileVersionRow[];

      const versions: FileVersion[] = [];
      for (const row of rows) {
        const result = rowToFileVersion(row);
        if (!result.ok) return result;
        versions.push(result.value);
      }

      return { ok: true, value: versions };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to query file versions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async findVersionsByHash(
    contentHash: string,
  ): Promise<Result<FileVersion[]>> {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      return failure(
        "INVALID_INPUT",
        "Content hash must be a valid 64-character lowercase hexadecimal SHA-256.",
      );
    }

    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type
        FROM file_versions
        WHERE content_hash = ?
        ORDER BY captured_at DESC
      `);

      const rows = stmt.all(contentHash) as unknown as FileVersionRow[];
      const versions: FileVersion[] = [];
      for (const row of rows) {
        const result = rowToFileVersion(row);
        if (!result.ok) return result;
        versions.push(result.value);
      }

      return { ok: true, value: versions };
    } catch (error) {
      return failure(
        "INTERNAL",
        `Failed to find file versions by hash: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
