import { z } from 'zod';
import { idSchema, timestampSchema } from './common';

export const httpUrlSchema = z
  .url()
  .max(8192)
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Only HTTP(S) URLs without embedded credentials are accepted.');

export const fileReferenceSchema = z.strictObject({
  id: idSchema,
  displayName: z.string().min(1).max(255),
  identity: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('verified-path'),
      absolutePath: z.string().min(1).max(32767),
      verifiedAt: timestampSchema,
    }),
    z.strictObject({ kind: z.literal('unverified'), observedTitle: z.string().max(2048) }),
  ]),
});
export type FileReference = z.infer<typeof fileReferenceSchema>;

export const fileVersionSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  fileId: idSchema,
  capturedAt: timestampSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().min(1).max(255),
});
export type FileVersion = z.infer<typeof fileVersionSchema>;

export const checkpointSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  name: z.string().trim().min(1).max(120),
  createdAt: timestampSchema,
  kept: z.boolean(),
  fileVersionIds: z.array(idSchema).max(1000),
  browserVisitIds: z.array(idSchema).max(1000),
  projectReferences: z
    .array(z.strictObject({ displayName: z.string().min(1).max(255), folderId: idSchema }))
    .max(100),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
