import { z } from "zod";
import { idSchema } from "./common";
import {
  documentFormatSchema,
  documentPreviewLimits,
  documentTextSchema,
  type DocumentFormat,
  type DocumentText,
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

/** Recording utility ↔ main relay bodies; the worker envelope separately fences the boot. */
export const documentRelayRequestSchema = z.discriminatedUnion("type", [
  documentParseRequestSchema.extend({ type: z.literal("document-parse") }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("document-stop"),
    id: idSchema,
  }),
]);
export type DocumentRelayRequest = z.infer<typeof documentRelayRequestSchema>;
export const documentRelayReplySchema = z.discriminatedUnion("type", [
  documentParseReplySchema.extend({
    type: z.literal("document-result"),
    closed: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("document-stopped"),
    id: idSchema,
    closed: z.boolean(),
  }),
]);
export type DocumentRelayReply = z.infer<typeof documentRelayReplySchema>;
export interface DocumentProcessor {
  readonly busy: boolean;
  extract(
    format: DocumentFormat,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DocumentText>;
  /** With an owner, stop only that extract call; an old owner cannot stop a replacement. */
  stop(owner?: AbortSignal): Promise<boolean>;
}
