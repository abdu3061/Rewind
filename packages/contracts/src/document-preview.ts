import { z } from "zod";

export const documentPreviewLimits = {
  inputBytes: 16 * 1024 * 1024,
  textBytes: 64 * 1024,
  pdfPages: 50,
  zipEntries: 2000,
  zipDeclaredBytes: 64 * 1024 * 1024,
  xmlBytes: 2 * 1024 * 1024,
  metadataXmlBytes: 128 * 1024,
  xmlNodes: 50000,
  xmlDepth: 128,
} as const;
export const documentFormatSchema = z.enum(["pdf", "docx"]);
export type DocumentFormat = z.infer<typeof documentFormatSchema>;
export const documentPreviewIssueSchema = z.enum([
  "unsupported",
  "malformed",
  "encrypted",
  "limit",
  "cancelled",
  "timeout",
  "unavailable",
]);
export type DocumentPreviewIssue = z.infer<typeof documentPreviewIssueSchema>;
export const documentTextSchema = z
  .discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("available"),
      format: documentFormatSchema,
      text: z
        .string()
        .max(documentPreviewLimits.textBytes)
        .refine(
          (text) =>
            new TextEncoder().encode(text).byteLength <=
            documentPreviewLimits.textBytes,
        ),
      truncated: z.boolean(),
      pagesRead: z
        .number()
        .int()
        .min(1)
        .max(documentPreviewLimits.pdfPages)
        .nullable(),
      totalPages: z.number().int().positive().safe().nullable(),
    }),
    z.strictObject({
      state: z.literal("unavailable"),
      format: documentFormatSchema,
      reason: documentPreviewIssueSchema,
    }),
  ])
  .refine((value) => {
    if (value.state === "unavailable") return true;
    return value.format === "docx"
      ? value.pagesRead === null && value.totalPages === null
      : value.pagesRead !== null &&
          value.totalPages !== null &&
          value.pagesRead <= value.totalPages &&
          (value.pagesRead === value.totalPages || value.truncated);
  });
export type DocumentText = z.infer<typeof documentTextSchema>;
