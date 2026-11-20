import { z } from "zod";
import { resultSchema, type Result, idSchema, timestampSchema } from "./common";
import type { RecoveryDirectoryProof } from "./recovery";
import { recoveryProposalSchema } from "./recovery";

const boundedBytes = z
  .number()
  .int()
  .min(0)
  .max(16 * 1024 ** 2);
export const recoveryFileEvidenceSchema = z.strictObject({
  osIdentity: z.string().regex(/^[a-f0-9]{8}:[a-f0-9]{16}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: boundedBytes,
  lastWriteToken: z.string().regex(/^[a-f0-9]{16}$/),
});
export type RecoveryFileEvidence = z.infer<typeof recoveryFileEvidenceSchema>;
export interface RecoveryOverwriteTarget {
  directory: RecoveryDirectoryProof;
  name: string;
  evidence: RecoveryFileEvidence;
}
export interface RecoveryOverwriteReceipt {
  target: RecoveryFileEvidence;
  preserved: RecoveryFileEvidence;
}
export const nativeOverwriteReplySchema = z.strictObject({
  status: z.enum(["inspected", "replaced", "failed"]),
  code: z.enum(["ok", "conflict", "integrity", "unavailable"]),
  target: recoveryFileEvidenceSchema.nullable(),
  preserved: recoveryFileEvidenceSchema.nullable(),
  targetTouched: z.boolean(),
  originalRestored: z.boolean(),
});
/** Private native port. Composition must own explicit, single-use user confirmation. */
export interface RecoveryOverwriteWriter {
  inspect(
    directory: RecoveryDirectoryProof,
    name: string,
  ): Promise<Result<RecoveryFileEvidence>>;
  overwrite(
    target: RecoveryOverwriteTarget,
    backupName: string,
    bytes: Uint8Array,
    hash: string,
  ): Promise<Result<RecoveryOverwriteReceipt>>;
  close(): Promise<Result<void>>;
}

export const recoveryOverwriteProposalSchema =
  recoveryProposalSchema.safeExtend({
    mode: z.literal("overwrite"),
    requiresCurrentFilePreservation: z.literal(true),
    sourceLabel: z.string().min(1).max(32767),
    capturedAt: timestampSchema,
    contentHash: recoveryFileEvidenceSchema.shape.contentHash,
    byteLength: boundedBytes,
    currentContentHash: recoveryFileEvidenceSchema.shape.contentHash,
    currentByteLength: boundedBytes,
    preservationLabel: z.string().min(4).max(240),
  });
export type RecoveryOverwriteProposal = z.infer<
  typeof recoveryOverwriteProposalSchema
>;
export const recoveryOverwriteResultSchema = z.strictObject({
  proposalId: idSchema,
  fileVersionId: idSchema,
  recoveredAt: timestampSchema,
  mode: z.literal("overwrite"),
  destinationLabel: z.string().min(4).max(240),
  preservationLabel: z.string().min(4).max(240),
  contentHash: recoveryFileEvidenceSchema.shape.contentHash,
  byteLength: boundedBytes,
  preservedContentHash: recoveryFileEvidenceSchema.shape.contentHash,
  preservedByteLength: boundedBytes,
});
export type RecoveryOverwriteResult = z.infer<
  typeof recoveryOverwriteResultSchema
>;
export const recoveryOverwriteProposalResponseSchema = resultSchema(
  recoveryOverwriteProposalSchema.nullable(),
);
export const recoveryOverwriteResultResponseSchema = resultSchema(
  recoveryOverwriteResultSchema,
);
