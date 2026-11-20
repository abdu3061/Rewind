import { z } from "zod";
import { resultSchema } from "./common";
import { documentAuthoritySchema } from "./document-preview";
import {
  fileTextCountsSchema,
  fileTextIndexStateSchema,
  fileTextQuerySchema,
  fileTextSearchPageSchema,
} from "./file-text";

export const fileTextIndexRequestSchema = z.strictObject({
  confirmed: z.literal(true),
  retryFailures: z.boolean(),
});
export type FileTextIndexRequest = z.infer<typeof fileTextIndexRequestSchema>;
export const fileTextControlStateSchema = z.strictObject({
  authority: documentAuthoritySchema,
  counts: fileTextCountsSchema,
  indexing: fileTextIndexStateSchema,
  automaticPaused: z.boolean(),
});
export type FileTextControlState = z.infer<typeof fileTextControlStateSchema>;
export const fileTextSearchReceiptSchema = fileTextSearchPageSchema
  .extend({
    authority: documentAuthoritySchema,
  })
  .refine((value) => value.hasMore === Boolean(value.nextBefore));
export type FileTextSearchReceipt = z.infer<typeof fileTextSearchReceiptSchema>;
export const fileTextControlResponseSchema = resultSchema(
  fileTextControlStateSchema,
);
export const fileTextSearchResponseSchema = resultSchema(
  fileTextSearchReceiptSchema,
);
export const fileTextCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("content.state") }),
  z.strictObject({
    kind: z.literal("content.index"),
    value: fileTextIndexRequestSchema,
  }),
  z.strictObject({ kind: z.literal("content.stop") }),
  z.strictObject({ kind: z.literal("content.clear-search") }),
  z.strictObject({
    kind: z.literal("content.search"),
    query: fileTextQuerySchema,
  }),
]);
export type FileTextCommand = z.infer<typeof fileTextCommandSchema>;
