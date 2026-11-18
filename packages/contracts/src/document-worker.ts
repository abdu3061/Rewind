import { z } from "zod";
import { idSchema } from "./common";
import {
  documentFormatSchema,
  documentPreviewLimits,
  documentTextSchema,
} from "./document-preview";

/** Private composition protocol. Never accepted as a renderer capability. */
export const documentParseRequestSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("parse"),
  id: idSchema,
  format: documentFormatSchema,
  bytes: z
    .instanceof(Uint8Array)
    .refine(
      (value) =>
        value.byteLength > 0 &&
        value.byteLength <= documentPreviewLimits.inputBytes,
    ),
});
export type DocumentParseRequest = z.infer<typeof documentParseRequestSchema>;
export const documentParseReplySchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("parsed"),
  id: idSchema,
  result: documentTextSchema,
});
export type DocumentParseReply = z.infer<typeof documentParseReplySchema>;
