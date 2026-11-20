import type { DatabaseConnection } from "./database";
import {
  failure,
  fileReferenceSchema,
  fileVersionSchema,
  idSchema,
  type FileReference,
  type FileRepository,
  type FileVersion,
  type Id,
  type Result,
} from "@rewind/contracts";
import { writeFileReference } from "./file-reference";

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

function rowToFileReference(row: FileRow): FileReference {
  if (row.identity_kind === "verified-path") {
    return {
      id: row.id,
      displayName: row.display_name,
      identity: {
        kind: "verified-path",
        absolutePath: row.absolute_path ?? "",
        verifiedAt: row.verified_at ?? "",
      },
    };
  }

  return {
    id: row.id,
    displayName: row.display_name,
    identity: {
      kind: "unverified",
      observedTitle: row.observed_title ?? "",
    },
  };
}

function rowToFileVersion(row: FileVersionRow): FileVersion {
  return {
    id: row.id,
    sessionId: row.session_id,
    fileId: row.file_id,
    capturedAt: row.captured_at,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    mediaType: row.media_type,
  };
}

export class SqliteFileRepository implements FileRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async saveReference(file: FileReference): Promise<Result<void>> {
    const parsed = fileReferenceSchema.safeParse(file);
    if (!parsed.success)
      return failure("INVALID_INPUT", "File reference is invalid.");
    try {
      writeFileReference(this.db, parsed.data);
      return { ok: true, value: undefined };
    } catch {
      return failure("INTERNAL", "Failed to save file reference.");
    }
  }

  async getReference(fileId: Id): Promise<Result<FileReference | null>> {
    if (!idSchema.safeParse(fileId).success)
      return failure("INVALID_INPUT", "A file ID is required.");
    try {
      const stmt = this.db.prepare(`
        SELECT id, display_name, identity_kind, absolute_path, verified_at, observed_title
        FROM files
        WHERE id = ?
      `);

      const row = stmt.get(fileId) as unknown as FileRow | undefined;
      return {
        ok: true,
        value: row ? fileReferenceSchema.parse(rowToFileReference(row)) : null,
      };
    } catch {
      return failure(
        "INTERNAL",
        "Stored file identity is unavailable or invalid.",
      );
    }
  }

  async addVersion(version: FileVersion): Promise<Result<void>> {
    const parsed = fileVersionSchema.safeParse(version);
    if (!parsed.success)
      return failure("INVALID_INPUT", "File version metadata is invalid.");
    version = parsed.data;
    try {
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
    } catch {
      return failure("INTERNAL", "File version metadata could not be saved.");
    }
  }

  async getVersion(id: Id): Promise<Result<FileVersion | null>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "A version ID is required.");
    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type
        FROM file_versions
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as FileVersionRow | undefined;
      return {
        ok: true,
        value: row ? fileVersionSchema.parse(rowToFileVersion(row)) : null,
      };
    } catch {
      return failure(
        "INTERNAL",
        "Stored file version metadata is unavailable or invalid.",
      );
    }
  }

  async listVersions(fileId: Id): Promise<Result<FileVersion[]>> {
    if (!idSchema.safeParse(fileId).success)
      return failure("INVALID_INPUT", "A file ID is required.");
    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type
        FROM file_versions
        WHERE file_id = ?
        ORDER BY captured_at DESC
      `);

      const rows = stmt.all(fileId) as unknown as FileVersionRow[];
      return {
        ok: true,
        value: rows.map((row) =>
          fileVersionSchema.parse(rowToFileVersion(row)),
        ),
      };
    } catch {
      return failure(
        "INTERNAL",
        "Stored file versions are unavailable or invalid.",
      );
    }
  }
}
