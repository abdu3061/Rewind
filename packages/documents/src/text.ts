import {
  documentPreviewLimits,
  type DocumentFormat,
  type DocumentPreviewIssue,
  type DocumentText,
} from "@rewind/contracts";

export class DocumentFailure extends Error {
  constructor(readonly reason: DocumentPreviewIssue) {
    super("DOCUMENT_PREVIEW_FAILED");
  }
}
export const rejectDocument = (reason: DocumentPreviewIssue): never => {
  throw new DocumentFailure(reason);
};
export const unavailableDocument = (
  format: DocumentFormat,
  reason: DocumentPreviewIssue,
): DocumentText => ({ state: "unavailable", format, reason });
/** A UTF-8 byte budget; no clipped surrogate or invented replacement character. */
export class PreviewText {
  private readonly parts: string[] = [];
  private length = 0;
  truncated = false;
  append(text: string): void {
    if (this.truncated || !text) return;
    const size = Buffer.byteLength(text, "utf8"),
      remaining = documentPreviewLimits.textBytes - this.length;
    if (size <= remaining) {
      this.parts.push(text);
      this.length += size;
      return;
    }
    const clipped: string[] = [];
    let used = 0;
    for (const codepoint of text) {
      const bytes = Buffer.byteLength(codepoint, "utf8");
      if (used + bytes > remaining) break;
      clipped.push(codepoint);
      used += bytes;
    }
    this.parts.push(clipped.join(""));
    this.length += used;
    this.truncated = true;
  }
  value(): string {
    return this.parts.join("");
  }
}
