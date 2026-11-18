import { z } from "zod";
import { idSchema, timestampSchema, type Result } from "./common";
import { searchResultSchema, sourceReferenceSchema } from "./search";

export const assistantEvidenceKeySchema = z
  .string()
  .regex(/^E(?:[1-9]|1[0-2])$/);
export const assistantEvidenceSchema = z.strictObject({
  key: assistantEvidenceKeySchema,
  source: sourceReferenceSchema,
  occurredAt: timestampSchema,
  title: z.string().max(300),
  excerpt: z.string().max(800),
  evidence: searchResultSchema.shape.evidence,
});
export type AssistantEvidence = z.infer<typeof assistantEvidenceSchema>;
/** Private approved plan, not a renderer-provided evidence or cloud-authorization payload. */
export const assistantApprovedRequestSchema = z
  .strictObject({
    id: idSchema,
    question: z.string().trim().min(1).max(1000),
    evidence: z
      .array(assistantEvidenceSchema)
      .max(12)
      .refine(
        (items) => new Set(items.map((item) => item.key)).size === items.length,
      ),
    confirmed: z.literal(true),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 24 * 1024,
    "Approved evidence exceeds the cloud request budget.",
  );
export type AssistantApprovedRequest = z.infer<
  typeof assistantApprovedRequestSchema
>;
export const assistantToolArgumentsSchema = z.strictObject({
  keys: z
    .array(assistantEvidenceKeySchema)
    .min(1)
    .max(4)
    .refine((keys) => new Set(keys).size === keys.length),
});
export const assistantModelAnswerSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(4000),
    sourceKeys: z
      .array(assistantEvidenceKeySchema)
      .max(12)
      .refine((keys) => new Set(keys).size === keys.length),
    insufficientEvidence: z.boolean(),
  })
  .refine(
    (value) => value.insufficientEvidence || value.sourceKeys.length > 0,
    "An answer requires real evidence citations.",
  );
export const evidenceAnswerSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(4000),
    sources: z.array(sourceReferenceSchema).max(12),
    insufficientEvidence: z.boolean(),
  })
  .refine((value) => value.insufficientEvidence || value.sources.length > 0);
export type EvidenceAnswer = z.infer<typeof evidenceAnswerSchema>;

// Privileged credential boundary only. These schemas do not create a renderer capability.
export const geminiApiKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,512}$/);
export const assistantCredentialSchema = z
  .strictObject({
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    apiKey: geminiApiKeySchema.nullable(),
    updatedAt: timestampSchema.nullable(),
  })
  .refine((value) =>
    value.revision === 0
      ? value.apiKey === null && value.updatedAt === null
      : value.updatedAt !== null,
  );
export type AssistantCredential = z.infer<typeof assistantCredentialSchema>;
export interface AssistantCredentialStore {
  read(): Promise<Result<AssistantCredential>>;
  write(
    expectedRevision: number,
    apiKey: string | null,
    updatedAt: string,
  ): Promise<Result<void>>;
}
export const assistantCredentialChallengeSchema = z.strictObject({
  id: idSchema,
  expiresAt: timestampSchema,
  modulus: z.string().regex(/^[A-Za-z0-9+/]{683}=$/),
  exponent: z.literal("AQAB"),
});
export type AssistantCredentialChallenge = z.infer<
  typeof assistantCredentialChallengeSchema
>;
export const assistantSealedCredentialSchema = z.strictObject({
  id: idSchema,
  sealed: z.string().regex(/^[A-Za-z0-9+/]{683}=$/),
});
export type AssistantSealedCredential = z.infer<
  typeof assistantSealedCredentialSchema
>;
export const assistantCredentialPlaintextSchema = z.strictObject({
  id: idSchema,
  apiKey: geminiApiKeySchema,
});
