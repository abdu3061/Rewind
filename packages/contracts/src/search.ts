import { z } from 'zod';
import { idSchema, timestampSchema } from './common';

export const searchQuerySchema = z
  .strictObject({
    text: z.string().trim().min(1).max(2000),
    mode: z.enum(['keyword', 'natural-language']),
    sessionId: idSchema.optional(),
    from: timestampSchema.optional(),
    to: timestampSchema.optional(),
    limit: z.number().int().min(1).max(100),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, 'Invalid time range.');
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export const sourceReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('activity'), activityId: idSchema }),
  z.strictObject({ kind: z.literal('browser-visit'), browserVisitId: idSchema }),
  z.strictObject({ kind: z.literal('file-version'), fileId: idSchema, fileVersionId: idSchema }),
  z.strictObject({ kind: z.literal('checkpoint'), checkpointId: idSchema }),
]);
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export const searchResultSchema = z.strictObject({
  source: sourceReferenceSchema,
  occurredAt: timestampSchema,
  title: z.string().max(2048),
  excerpt: z.string().max(4000),
  evidence: z.enum(['recorded', 'verified-path', 'title-only']),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
