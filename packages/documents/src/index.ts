import {
  documentFormatSchema,
  documentPreviewLimits,
  documentTextSchema,
  type DocumentFormat,
  type DocumentText,
} from "@rewind/contracts";
import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";
import { DocumentFailure, unavailableDocument } from "./text";

/** Private utility implementation: callers must supply an external hard deadline and resource isolation. */
export async function extractDocumentText(
  format: DocumentFormat,
  bytes: Uint8Array,
): Promise<DocumentText> {
  if (
    !documentFormatSchema.safeParse(format).success ||
    !(bytes instanceof Uint8Array)
  )
    throw new Error("INVALID_DOCUMENT_REQUEST");
  if (!bytes.byteLength || bytes.byteLength > documentPreviewLimits.inputBytes)
    return unavailableDocument(format, "limit");
  try {
    return documentTextSchema.parse(
      format === "docx" ? await extractDocx(bytes) : await extractPdf(bytes),
    );
  } catch (error) {
    return unavailableDocument(
      format,
      error instanceof DocumentFailure ? error.reason : "unavailable",
    );
  }
}
