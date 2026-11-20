import { z } from "zod";
import { appErrorSchema, idSchema, timestampSchema } from "./common";
import { fileVersionSchema } from "./files";
import { capturedVersionSummarySchema } from "./file-controls";
import { documentPreviewLimits, documentTextSchema } from "./document-preview";

export const fileTextRevision = 1 as const;
export const fileTextFormatSchema = z.enum(["utf8", "pdf", "docx"]);
export type FileTextFormat = z.infer<typeof fileTextFormatSchema>;
export function fileTextFormat(mediaType: string): FileTextFormat | null {
  if (mediaType === "application/pdf") return "pdf";
  if (
    mediaType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "docx";
  return mediaType.startsWith("text/") || mediaType === "application/json"
    ? "utf8"
    : null;
}
export const fileTextExtractionSchema = z
  .discriminatedUnion("state", [
    documentTextSchema.options[0].extend({ format: fileTextFormatSchema }),
    documentTextSchema.options[1].extend({ format: fileTextFormatSchema }),
  ])
  .refine((value) =>
    value.format === "utf8"
      ? value.state !== "available" ||
        (value.pagesRead === null && value.totalPages === null)
      : documentTextSchema.safeParse(value).success,
  );
export type FileTextExtraction = z.infer<typeof fileTextExtractionSchema>;
/** Privileged source-derived write. Never accepted from renderer or provider tools. */
export const fileTextWriteSchema = z.strictObject({
  versionId: idSchema,
  contentHash: fileVersionSchema.shape.contentHash,
  revision: z.literal(fileTextRevision),
  extraction: fileTextExtractionSchema.refine(
    (value) => value.state !== "unavailable" || value.reason !== "cancelled",
  ),
  indexedAt: timestampSchema,
});
export type FileTextWrite = z.infer<typeof fileTextWriteSchema>;
export const fileTextRecordSchema = fileTextWriteSchema
  .extend({
    textHash: fileVersionSchema.shape.contentHash.nullable(),
  })
  .refine(
    (value) =>
      (value.extraction.state === "available") === (value.textHash !== null),
  );
export type FileTextRecord = z.infer<typeof fileTextRecordSchema>;
export const fileTextCursorSchema = z.strictObject({
  capturedAt: timestampSchema,
  id: idSchema,
});
export const fileTextCandidateQuerySchema = z.strictObject({
  through: timestampSchema,
  after: fileTextCursorSchema.optional(),
  sessionId: idSchema.optional(),
  folderIds: z.array(idSchema).max(100).optional(),
  retryFailures: z.boolean(),
});
export type FileTextCandidateQuery = z.infer<
  typeof fileTextCandidateQuerySchema
>;
/** Private indexing source; the folder binding is reauthorized by the engine at use. */
export const fileTextCandidateSchema = capturedVersionSummarySchema.extend({
  folderId: idSchema.nullable(),
});
export type FileTextCandidate = z.infer<typeof fileTextCandidateSchema>;
/** Private run admission. Automatic work is restricted to the active selected-folder session. */
export const fileTextRunScopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("automatic"),
    query: fileTextCandidateQuerySchema.omit({ after: true }).extend({
      sessionId: idSchema,
      folderIds: z.array(idSchema).min(1).max(100),
      retryFailures: z.literal(false),
    }),
  }),
  z.strictObject({
    mode: z.literal("saved"),
    query: fileTextCandidateQuerySchema.omit({ after: true }),
  }),
]);
export type FileTextRunScope = z.infer<typeof fileTextRunScopeSchema>;
export const fileTextIndexStateSchema = z
  .strictObject({
    mode: z.enum(["automatic", "saved"]).nullable(),
    busy: z.boolean(),
    processed: z.number().int().nonnegative().safe(),
    indexed: z.number().int().nonnegative().safe(),
    unavailable: z.number().int().nonnegative().safe(),
    error: appErrorSchema.nullable(),
  })
  .refine((value) => value.processed === value.indexed + value.unavailable);
export type FileTextIndexState = z.infer<typeof fileTextIndexStateSchema>;
export const fileTextCountsSchema = z
  .strictObject({
    eligible: z.number().int().nonnegative().safe(),
    indexed: z.number().int().nonnegative().safe(),
    unavailable: z.number().int().nonnegative().safe(),
    pending: z.number().int().nonnegative().safe(),
  })
  .refine(
    (value) =>
      value.eligible === value.indexed + value.unavailable + value.pending,
  );
export type FileTextCounts = z.infer<typeof fileTextCountsSchema>;
export const fileTextQuerySchema = z
  .strictObject({
    text: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(25),
    sessionId: idSchema.optional(),
    from: timestampSchema.optional(),
    to: timestampSchema.optional(),
    before: fileTextCursorSchema.optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to);
export type FileTextQuery = z.infer<typeof fileTextQuerySchema>;
export const fileTextHitSchema = capturedVersionSummarySchema.extend({
  snippet: z
    .string()
    .max(1000)
    .refine(
      (value) =>
        value.length <= 1000 && new TextEncoder().encode(value).length <= 1000,
    ),
  format: fileTextFormatSchema,
  truncated: z.boolean(),
});
export type FileTextHit = z.infer<typeof fileTextHitSchema>;
export const fileTextSearchPageSchema = z.strictObject({
  hits: z.array(fileTextHitSchema).max(25),
  hasMore: z.boolean(),
  nextBefore: fileTextCursorSchema.optional(),
});
export type FileTextSearchPage = z.infer<typeof fileTextSearchPageSchema>;
export const MAX_FILE_TEXT_BYTES = documentPreviewLimits.textBytes;
