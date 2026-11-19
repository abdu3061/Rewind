import { z } from "zod";
import { idSchema, resultSchema, timestampSchema } from "./common";
import { fileVersionSchema } from "./files";
import { protectedFolderSchema } from "./snapshots";
import { documentAuthoritySchema } from "./document-preview";

export const folderCaptureStatusSchema = z.strictObject({
  state: z.enum(["off", "pending", "capturing", "watching", "unavailable"]),
  captured: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  issue: z.string().max(500).nullable(),
});
export type FolderCaptureStatus = z.infer<typeof folderCaptureStatusSchema>;
export const fileProtectionStateSchema = z.strictObject({
  permission: z.boolean(),
  folders: z.array(protectedFolderSchema).max(100),
  status: folderCaptureStatusSchema,
});
export type FileProtectionState = z.infer<typeof fileProtectionStateSchema>;
export const versionListQuerySchema = z.strictObject({
  sessionId: idSchema.optional(),
  fileId: idSchema.optional(),
  limit: z.number().int().min(1).max(100),
  before: z
    .strictObject({ capturedAt: timestampSchema, id: idSchema })
    .optional(),
});
export type VersionListQuery = z.infer<typeof versionListQuerySchema>;
export const capturedVersionSummarySchema = z.strictObject({
  version: fileVersionSchema,
  displayName: z.string().min(1).max(255),
  sourceLabel: z.string().min(1).max(1024),
});
export type CapturedVersionSummary = z.infer<
  typeof capturedVersionSummarySchema
>;
export const versionPreviewSchema = z.strictObject({
  authority: documentAuthoritySchema,
  version: fileVersionSchema,
  displayName: z.string().min(1).max(255),
  sourceLabel: z.string().min(1).max(1024),
  text: z.string().max(65536).nullable(),
  truncated: z.boolean(),
  warning: z.string().max(500).nullable(),
});
export type VersionPreview = z.infer<typeof versionPreviewSchema>;
export const fileProtectionResponseSchema = resultSchema(
  fileProtectionStateSchema,
);
export const folderSelectionResponseSchema = resultSchema(
  protectedFolderSchema.nullable(),
);
export const versionListResponseSchema = resultSchema(
  z.array(capturedVersionSummarySchema).max(100),
);
export const versionPreviewResponseSchema = resultSchema(versionPreviewSchema);
export const versionSourceResponseSchema = resultSchema(
  capturedVersionSummarySchema,
);
export const versionInfoResponseSchema = resultSchema(
  fileVersionSchema.nullable(),
);
export const fileCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("files.state") }),
  z.strictObject({ kind: z.literal("files.select") }),
  z.strictObject({ kind: z.literal("files.permission"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("files.remove"), id: idSchema }),
  z.strictObject({
    kind: z.literal("versions.list"),
    query: versionListQuerySchema,
  }),
  z.strictObject({
    kind: z.literal("versions.preview"),
    id: idSchema,
    requestId: idSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("versions.cancel-preview"),
    requestId: idSchema,
  }),
  z.strictObject({ kind: z.literal("versions.info"), id: idSchema }),
]);
