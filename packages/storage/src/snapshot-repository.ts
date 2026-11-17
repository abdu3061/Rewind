import { createHash } from "node:crypto";
import { win32 as path } from "node:path";
import { z } from "zod";
import {
  activityEventSchema,
  failure,
  fileVersionSchema,
  idSchema,
  protectedFolderSchema,
  snapshotCaptureSchema,
  timestampSchema,
  userSettingsSchema,
  type ActivityEvent,
  type FileVersion,
  type ProtectedFolder,
  type Result,
  type SnapshotCapture,
  type SnapshotStore,
  type UserSettings,
} from "@rewind/contracts";
import type { DatabaseConnection, SqlValue } from "./database";
import { writeFileReference } from "./file-reference";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function version(row: Record<string, unknown>): FileVersion {
  return fileVersionSchema.parse({
    id: row.id,
    fileId: row.file_id,
    sessionId: row.session_id,
    capturedAt: row.captured_at,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    mediaType: row.media_type,
  });
}
const versionQuery = z.strictObject({
  fileId: idSchema.optional(),
  limit: z.number().int().min(1).max(100),
  before: z
    .strictObject({ capturedAt: timestampSchema, id: idSchema })
    .optional(),
});

export function verifySnapshotSchema(db: DatabaseConnection): void {
  for (const sql of [
    "SELECT id,absolute_path,selected_at,os_identity FROM protected_folders LIMIT 0",
    "SELECT content_hash,bytes FROM snapshot_blobs LIMIT 0",
    "SELECT blob_hash,os_identity FROM file_versions LIMIT 0",
    "SELECT file_id,folder_id,relative_path,os_identity FROM file_bindings LIMIT 0",
  ])
    db.prepare(sql).all();
  const trigger = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='snapshot_blob_immutable'",
    )
    .get();
  if (!trigger) throw new Error("SNAPSHOT_SCHEMA_INCOMPLETE");
  const invalid = db
    .prepare(
      "SELECT v.id FROM file_versions v JOIN snapshot_blobs b ON b.content_hash=v.blob_hash WHERE v.byte_length!=length(b.bytes) OR v.content_hash!=v.blob_hash OR v.os_identity IS NULL LIMIT 1",
    )
    .get();
  if (invalid) throw new Error("SNAPSHOT_METADATA_INTEGRITY");
}

/** Instantiated only after SecureStorage verifies encryption, migrations and integrity. */
export class SnapshotRepository implements SnapshotStore {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly physicalBytes: (settings: UserSettings) => number,
  ) {}
  async saveFolder(input: ProtectedFolder): Promise<Result<void>> {
    const parsed = protectedFolderSchema.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Protected folder metadata is invalid.");
    const folder = parsed.data;
    try {
      const existing = this.db
        .prepare(
          "SELECT absolute_path,os_identity FROM protected_folders WHERE id=?",
        )
        .get(folder.id);
      if (
        existing &&
        (existing.absolute_path !== folder.absolutePath ||
          existing.os_identity !== folder.osIdentity)
      )
        return failure(
          "CONFLICT",
          "Protected folder identity changed. Select it again.",
        );
      this.db
        .prepare(
          "INSERT INTO protected_folders(id,absolute_path,selected_at,os_identity) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(
          folder.id,
          folder.absolutePath,
          folder.selectedAt,
          folder.osIdentity,
        );
      return { ok: true, value: undefined };
    } catch {
      return failure("UNAVAILABLE", "Protected folder could not be saved.");
    }
  }
  async listFolders(): Promise<Result<ProtectedFolder[]>> {
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM protected_folders ORDER BY selected_at,id LIMIT 101",
        )
        .all() as Record<string, unknown>[];
      if (rows.length > 100) throw new Error("FOLDER_LIMIT");
      return {
        ok: true,
        value: rows.map((row) =>
          protectedFolderSchema.parse({
            id: row.id,
            absolutePath: row.absolute_path,
            selectedAt: row.selected_at,
            osIdentity: row.os_identity,
          }),
        ),
      };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Protected folder metadata is unavailable.",
      );
    }
  }
  async removeFolder(id: string): Promise<Result<void>> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "A folder ID is required.");
    try {
      this.db.prepare("DELETE FROM protected_folders WHERE id=?").run(id);
      // This revokes future capture. Already captured bytes obey retention/deletion policy.
      return { ok: true, value: undefined };
    } catch {
      return failure("UNAVAILABLE", "Protected folder could not be removed.");
    }
  }
  async capture(
    input: SnapshotCapture,
    observation: ActivityEvent,
    authorized: () => boolean,
  ): Promise<Result<FileVersion>> {
    const parsed = snapshotCaptureSchema.safeParse(input);
    const event = activityEventSchema.safeParse(observation);
    if (!parsed.success || !event.success)
      return failure("INVALID_INPUT", "Snapshot input is invalid.");
    const value = parsed.data;
    const v = value.version;
    if (
      value.file.id !== v.fileId ||
      v.byteLength !== value.bytes.byteLength ||
      event.data.type !== "file-change" ||
      event.data.payload.fileId !== v.fileId ||
      event.data.sessionId !== v.sessionId ||
      event.data.occurredAt !== v.capturedAt ||
      !["created", "updated"].includes(event.data.payload.change)
    )
      return failure(
        "INVALID_INPUT",
        "Snapshot evidence does not match its version.",
      );
    if (hash(value.bytes) !== v.contentHash)
      return failure(
        "INTEGRITY_FAILURE",
        "Snapshot bytes failed integrity verification.",
      );
    const relative = value.binding.relativePath;
    if (
      path.isAbsolute(relative) ||
      relative
        .split(/[\\/]/)
        .some(
          (part) =>
            !part || part === "." || part === ".." || part.includes(":"),
        )
    )
      return failure("INVALID_INPUT", "Snapshot relative identity is invalid.");
    let transaction = false;
    try {
      if (!authorized())
        return failure("FORBIDDEN", "Snapshot authority expired.");
      this.db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const folder = this.db
        .prepare("SELECT absolute_path FROM protected_folders WHERE id=?")
        .get(value.binding.folderId);
      if (
        !folder ||
        value.file.identity.kind !== "verified-path" ||
        path.join(String(folder.absolute_path), relative).toLowerCase() !==
          value.file.identity.absolutePath.toLowerCase()
      )
        throw new Error("FOLDER_SCOPE");
      const session = this.db
        .prepare("SELECT status,started_at FROM sessions WHERE id=?")
        .get(v.sessionId);
      if (
        session?.status !== "active" ||
        String(session.started_at) > v.capturedAt
      )
        throw new Error("SESSION_SCOPE");
      const oldBinding = this.db
        .prepare(
          "SELECT folder_id,relative_path FROM file_bindings WHERE file_id=?",
        )
        .get(v.fileId);
      if (
        oldBinding &&
        (oldBinding.folder_id !== value.binding.folderId ||
          String(oldBinding.relative_path).toLowerCase() !==
            relative.toLowerCase())
      )
        throw new Error("FILE_IDENTITY_REUSE");
      const blob = this.db
        .prepare("SELECT bytes FROM snapshot_blobs WHERE content_hash=?")
        .get(v.contentHash);
      if (
        blob &&
        (!(blob.bytes instanceof Uint8Array) ||
          hash(blob.bytes) !== v.contentHash)
      )
        throw new Error("BLOB_INTEGRITY");
      const row = this.db
        .prepare("SELECT payload FROM runtime_settings WHERE id=1")
        .get();
      const settings = userSettingsSchema.parse(
        JSON.parse(String(row?.payload)),
      );
      const reserve = blob ? 65536 : value.bytes.byteLength * 4 + 65536;
      if (this.physicalBytes(settings) + reserve > settings.storageLimitBytes) {
        this.db.exec("ROLLBACK");
        transaction = false;
        return failure(
          "UNAVAILABLE",
          "Snapshot quota would be exceeded. Free storage or increase the limit.",
        );
      }
      writeFileReference(this.db, value.file);
      this.db
        .prepare(
          "INSERT INTO file_bindings(file_id,folder_id,relative_path,os_identity) VALUES (?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET os_identity=excluded.os_identity",
        )
        .run(
          v.fileId,
          value.binding.folderId,
          relative,
          value.binding.osIdentity,
        );
      if (!blob)
        this.db
          .prepare(
            "INSERT INTO snapshot_blobs(content_hash,bytes) VALUES (?,?)",
          )
          .run(v.contentHash, value.bytes);
      const latest = this.db
        .prepare(
          "SELECT * FROM file_versions WHERE file_id=? AND session_id=? AND blob_hash IS NOT NULL ORDER BY captured_at DESC,id DESC LIMIT 1",
        )
        .get(v.fileId, v.sessionId);
      let captured = v;
      if (latest && latest.content_hash === v.contentHash)
        captured = version(latest);
      else
        this.db
          .prepare(
            "INSERT INTO file_versions(id,session_id,file_id,captured_at,content_hash,byte_length,media_type,blob_hash,os_identity) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            v.id,
            v.sessionId,
            v.fileId,
            v.capturedAt,
            v.contentHash,
            v.byteLength,
            v.mediaType,
            v.contentHash,
            value.binding.osIdentity,
          );
      this.db
        .prepare(
          "INSERT INTO activities(id,session_id,type,source,occurred_at,payload) VALUES (?,?,?,?,?,?)",
        )
        .run(
          event.data.id,
          event.data.sessionId,
          event.data.type,
          event.data.source,
          event.data.occurredAt,
          JSON.stringify(event.data.payload),
        );
      if (!authorized()) {
        this.db.exec("ROLLBACK");
        transaction = false;
        return failure(
          "FORBIDDEN",
          "Snapshot authority changed before commit.",
        );
      }
      this.db.exec("COMMIT");
      transaction = false;
      return { ok: true, value: captured };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Snapshot could not be committed with verified bytes, scope and metadata.",
      );
    } finally {
      if (transaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* Owner closes a failed connection. */
        }
      }
    }
  }
  async read(
    versionId: string,
  ): Promise<Result<{ version: FileVersion; bytes: Uint8Array }>> {
    if (!idSchema.safeParse(versionId).success)
      return failure("INVALID_INPUT", "A version ID is required.");
    try {
      const row = this.db
        .prepare(
          "SELECT v.*, b.bytes FROM file_versions v JOIN snapshot_blobs b ON b.content_hash=v.blob_hash WHERE v.id=?",
        )
        .get(versionId);
      if (!row)
        return failure(
          "NOT_FOUND",
          "Captured bytes are no longer available for this version.",
        );
      const v = version(row);
      if (
        !(row.bytes instanceof Uint8Array) ||
        row.bytes.byteLength !== v.byteLength ||
        hash(row.bytes) !== v.contentHash
      )
        throw new Error("SNAPSHOT_INTEGRITY");
      return {
        ok: true,
        value: { version: v, bytes: new Uint8Array(row.bytes) },
      };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Captured bytes failed integrity verification.",
      );
    }
  }
  async listVersions(
    input: Parameters<SnapshotStore["listVersions"]>[0],
  ): Promise<Result<FileVersion[]>> {
    const parsed = versionQuery.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Version query is invalid.");
    try {
      const query = parsed.data;
      const conditions = ["v.blob_hash IS NOT NULL"];
      const args: SqlValue[] = [];
      if (query.fileId) {
        conditions.push("v.file_id=?");
        args.push(query.fileId);
      }
      if (query.before) {
        conditions.push(
          "(v.captured_at < ? OR (v.captured_at=? AND v.id < ?))",
        );
        args.push(
          query.before.capturedAt,
          query.before.capturedAt,
          query.before.id,
        );
      }
      args.push(query.limit);
      const rows = this.db
        .prepare(
          `SELECT v.*, length(b.bytes) AS stored_length FROM file_versions v JOIN snapshot_blobs b ON b.content_hash=v.blob_hash WHERE ${conditions.join(" AND ")} ORDER BY v.captured_at DESC,v.id DESC LIMIT ?`,
        )
        .all(...args) as Record<string, unknown>[];
      return {
        ok: true,
        value: rows.map((row) => {
          const v = version(row);
          if (row.stored_length !== v.byteLength)
            throw new Error("LENGTH_INTEGRITY");
          return v;
        }),
      };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Captured version history is unavailable or invalid.",
      );
    }
  }
}
