import { z } from "zod";
import { idSchema, timestampSchema, type Result } from "./common";
import {
  fileReferenceSchema,
  fileVersionSchema,
  type FileVersion,
} from "./files";
import type { ActivityEvent } from "./activity";

export const MAX_SNAPSHOT_BYTES = 16 * 1024 ** 2;
export const protectedFolderSchema = z.strictObject({
  id: idSchema,
  absolutePath: z.string().min(4).max(240),
  selectedAt: timestampSchema,
  osIdentity: z.string().min(1).max(128),
});
export type ProtectedFolder = z.infer<typeof protectedFolderSchema>;
export const nativeFolderProofSchema = protectedFolderSchema.pick({
  absolutePath: true,
  osIdentity: true,
});
export const nativeFileListingSchema = z
  .strictObject({
    paths: z.array(z.string().min(1).max(240)).max(2000),
    stamps: z.array(z.string().max(80)).max(2000),
    overflow: z.boolean(),
  })
  .refine((value) => value.paths.length === value.stamps.length);
export const nativeFileBytesSchema = z.strictObject({
  base64: z
    .string()
    .max(Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4)
    // A repeated quartet regex exhausts V8's stack on a valid 16 MiB capture.
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((value) => value.length % 4 === 0),
  byteLength: z.number().int().min(0).max(MAX_SNAPSHOT_BYTES),
  osIdentity: z.string().min(1).max(128),
});
export interface ProtectedFileAccess {
  validateFolder(
    path: string,
  ): Promise<Result<z.infer<typeof nativeFolderProofSchema>>>;
  list(
    folder: ProtectedFolder,
  ): Promise<Result<z.infer<typeof nativeFileListingSchema>>>;
  read(
    folder: ProtectedFolder,
    relativePath: string,
  ): Promise<Result<{ bytes: Uint8Array<ArrayBuffer>; osIdentity: string }>>;
  close(): Promise<Result<void>>;
}
export const snapshotBindingSchema = z.strictObject({
  folderId: idSchema,
  relativePath: z.string().min(1).max(240),
  osIdentity: z.string().min(1).max(128),
});
export type SnapshotBinding = z.infer<typeof snapshotBindingSchema>;
export const snapshotCaptureSchema = z.strictObject({
  file: fileReferenceSchema.refine(
    (file) => file.identity.kind === "verified-path",
  ),
  version: fileVersionSchema.extend({
    byteLength: z.number().int().min(0).max(MAX_SNAPSHOT_BYTES),
  }),
  binding: snapshotBindingSchema,
  bytes: z
    .instanceof(Uint8Array)
    .refine(
      (bytes): boolean =>
        bytes.byteLength <= MAX_SNAPSHOT_BYTES &&
        bytes.buffer instanceof ArrayBuffer,
    ),
});
export type SnapshotCapture = z.infer<typeof snapshotCaptureSchema>;
export interface SnapshotStore {
  info(versionId: string): Promise<Result<FileVersion | null>>;
  saveFolder(folder: ProtectedFolder): Promise<Result<void>>;
  listFolders(): Promise<Result<ProtectedFolder[]>>;
  removeFolder(id: string): Promise<Result<void>>;
  resolveFileId(
    folderId: string,
    relativePath: string,
  ): Promise<Result<string | null>>;
  /** Trusted engine port. Filesystem authorization is rechecked at use, never supplied by renderer. */
  capture(
    value: SnapshotCapture,
    event: ActivityEvent,
    authorized: () => boolean,
  ): Promise<Result<FileVersion>>;
  read(
    versionId: string,
  ): Promise<Result<{ version: FileVersion; bytes: Uint8Array }>>;
  listVersions(query: {
    fileId?: string | undefined;
    limit: number;
    before?: { capturedAt: string; id: string } | undefined;
  }): Promise<Result<FileVersion[]>>;
}
export interface FileCaptureIngestion {
  get(
    event: ActivityEvent,
    settings: Readonly<import("./settings").UserSettings>,
  ): Promise<Result<SnapshotCapture>>;
  save(
    value: SnapshotCapture,
    event: ActivityEvent,
    authorized: () => boolean,
  ): Promise<Result<FileVersion>>;
}
