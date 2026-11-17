import { z } from "zod";
import { idSchema, timestampSchema, resultSchema } from "./common";
import type { Result } from "./common";
import { fileVersionSchema } from "./files";

// Proposal IDs refer to engine-owned plans; a renderer cannot nominate arbitrary paths.
export const recoveryProposalSchema = z
  .strictObject({
    id: idSchema,
    fileVersionId: idSchema,
    fileId: idSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    mode: z.enum(["save-copy", "overwrite"]),
    destinationLabel: z.string().min(1).max(1024),
    requiresConfirmation: z.literal(true),
    requiresCurrentFilePreservation: z.boolean(),
  })
  .refine(
    (proposal) =>
      proposal.requiresCurrentFilePreservation ===
      (proposal.mode === "overwrite"),
    "Overwrite must preserve the current file.",
  );
export type RecoveryProposal = z.infer<typeof recoveryProposalSchema>;
export const recoveryResultSchema = z
  .strictObject({
    proposalId: idSchema,
    recoveredFileId: idSchema,
    recoveredAt: timestampSchema,
    mode: z.enum(["save-copy", "overwrite"]),
    preservedCurrentVersionId: idSchema.nullable(),
  })
  .refine(
    (result) =>
      result.mode !== "overwrite" || result.preservedCurrentVersionId !== null,
    "An overwrite requires a preserved current version.",
  );
export type RecoveryResult = z.infer<typeof recoveryResultSchema>;

export const nativeCopyReplySchema = z.strictObject({
  status: z.enum(["copied", "failed"]),
  code: z.enum(["ok", "conflict", "integrity", "unavailable"]),
  osIdentity: z.string().max(128).nullable(),
  contentHash: z.string().max(64).nullable(),
  byteLength: z
    .number()
    .int()
    .min(0)
    .max(16 * 1024 ** 2),
  cleanupConfirmed: z.boolean(),
});
export interface RecoveryDirectoryProof {
  absolutePath: string;
  osIdentity: string;
}
export interface RecoveryCopyReceipt {
  osIdentity: string;
  contentHash: string;
  byteLength: number;
}
export interface RecoveryCopyWriter {
  createCopy(
    directory: RecoveryDirectoryProof,
    name: string,
    bytes: Uint8Array,
    hash: string,
  ): Promise<Result<RecoveryCopyReceipt>>;
  close(): Promise<Result<void>>;
}

export const recoveryCopyProposalSchema = recoveryProposalSchema.safeExtend({
  mode: z.literal("save-copy"),
  requiresCurrentFilePreservation: z.literal(false),
  sourceLabel: z.string().min(1).max(32767),
  capturedAt: timestampSchema,
  contentHash: fileVersionSchema.shape.contentHash,
  byteLength: z
    .number()
    .int()
    .min(0)
    .max(16 * 1024 ** 2),
});
export type RecoveryCopyProposal = z.infer<typeof recoveryCopyProposalSchema>;
// A verified export receipt, not an invented captured-file identity or a claim of persistent tracking.
export const recoveryCopyResultSchema = z.strictObject({
  proposalId: idSchema,
  fileVersionId: idSchema,
  recoveredAt: timestampSchema,
  mode: z.literal("save-copy"),
  destinationLabel: z.string().min(1).max(240),
  contentHash: fileVersionSchema.shape.contentHash,
  byteLength: z
    .number()
    .int()
    .min(0)
    .max(16 * 1024 ** 2),
});
export type RecoveryCopyResult = z.infer<typeof recoveryCopyResultSchema>;
export const recoveryCopyProposalResponseSchema = resultSchema(
  recoveryCopyProposalSchema.nullable(),
);
export const recoveryCopyResultResponseSchema = resultSchema(
  recoveryCopyResultSchema,
);
export const recoveryCancelResponseSchema = resultSchema(z.literal(true));
export const recoveryCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("recovery.choose-copy"),
    versionId: idSchema,
  }),
  z.strictObject({
    kind: z.literal("recovery.confirm-copy"),
    proposalId: idSchema,
    confirmed: z.literal(true),
  }),
  z.strictObject({ kind: z.literal("recovery.cancel"), proposalId: idSchema }),
]);
