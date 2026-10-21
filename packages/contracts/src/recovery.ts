import { z } from 'zod';
import { idSchema, timestampSchema } from './common';

// Proposal IDs refer to engine-owned plans; a renderer cannot nominate arbitrary paths.
export const recoveryProposalSchema = z
  .strictObject({
    id: idSchema,
    fileVersionId: idSchema,
    fileId: idSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    mode: z.enum(['save-copy', 'overwrite']),
    destinationLabel: z.string().min(1).max(1024),
    requiresConfirmation: z.literal(true),
    requiresCurrentFilePreservation: z.boolean(),
  })
  .refine(
    (proposal) => proposal.requiresCurrentFilePreservation === (proposal.mode === 'overwrite'),
    'Overwrite must preserve the current file.',
  );
export type RecoveryProposal = z.infer<typeof recoveryProposalSchema>;
export const recoveryResultSchema = z
  .strictObject({
    proposalId: idSchema,
    recoveredFileId: idSchema,
    recoveredAt: timestampSchema,
    mode: z.enum(['save-copy', 'overwrite']),
    preservedCurrentVersionId: idSchema.nullable(),
  })
  .refine(
    (result) => result.mode !== 'overwrite' || result.preservedCurrentVersionId !== null,
    'An overwrite requires a preserved current version.',
  );
export type RecoveryResult = z.infer<typeof recoveryResultSchema>;
