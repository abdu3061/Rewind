import { DatabaseSync } from 'node:sqlite';
import {
  failure,
  type FileReference,
  type FileRepository,
  type FileVersion,
  type Id,
  type Result,
} from '@rewind/contracts';

interface FileRow {
  id: string;
  display_name: string;
  identity_kind: 'verified-path' | 'unverified';
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
  if (row.identity_kind === 'verified-path') {
    return {
      id: row.id,
      displayName: row.display_name,
      identity: {
        kind: 'verified-path',
        absolutePath: row.absolute_path ?? '',
        verifiedAt: row.verified_at ?? '',
      },
    };
  }

  return {
    id: row.id,
    displayName: row.display_name,
    identity: {
      kind: 'unverified',
      observedTitle: row.observed_title ?? '',
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
  constructor(private readonly db: DatabaseSync) {}

  async saveReference(file: FileReference): Promise<Result<void>> {
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

      if (file.identity.kind === 'verified-path') {
        absPath = file.identity.absolutePath;
        verAt = file.identity.verifiedAt;
      } else {
        obsTitle = file.identity.observedTitle;
      }

      stmt.run(file.id, file.displayName, file.identity.kind, absPath, verAt, obsTitle);

      return { ok: true, value: undefined };
    } catch (error) {
      return failure(
        'INTERNAL',
        `Failed to save file reference: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getReference(fileId: Id): Promise<Result<FileReference | null>> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, display_name, identity_kind, absolute_path, verified_at, observed_title
        FROM files
        WHERE id = ?
      `);

      const row = stmt.get(fileId) as unknown as FileRow | undefined;
      return { ok: true, value: row ? rowToFileReference(row) : null };
    } catch (error) {
      return failure(
        'INTERNAL',
        `Failed to get file reference: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async addVersion(version: FileVersion): Promise<Result<void>> {
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
    } catch (error) {
      return failure(
        'INTERNAL',
        `Failed to add file version: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getVersion(id: Id): Promise<Result<FileVersion | null>> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type
        FROM file_versions
        WHERE id = ?
      `);

      const row = stmt.get(id) as unknown as FileVersionRow | undefined;
      return { ok: true, value: row ? rowToFileVersion(row) : null };
    } catch (error) {
      return failure(
        'INTERNAL',
        `Failed to get file version: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listVersions(fileId: Id): Promise<Result<FileVersion[]>> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type
        FROM file_versions
        WHERE file_id = ?
        ORDER BY captured_at DESC
      `);

      const rows = stmt.all(fileId) as unknown as FileVersionRow[];
      return { ok: true, value: rows.map(rowToFileVersion) };
    } catch (error) {
      return failure(
        'INTERNAL',
        `Failed to list file versions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
