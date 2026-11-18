import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { open } from "node:fs/promises";
import {
  documentPreviewLimits as limits,
  type DocumentText,
} from "@rewind/contracts";
import { PreviewText, unavailableDocument } from "./text";

/** No document URL, actions, rendering, system-font lookup, external fetch or code evaluation. */
export async function extractPdf(bytes: Uint8Array): Promise<DocumentText> {
  if (new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-")
    return unavailableDocument("pdf", "malformed");
  let pdf: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return unavailableDocument("pdf", "unavailable");
  }
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  pdf.GlobalWorkerOptions.workerSrc = pathToFileURL(
    join(root, "legacy/build/pdf.worker.mjs"),
  ).href;
  const data = Uint8Array.from(bytes);
  // Accept only a single packaged font/CMap basename, never a document URL/path.
  class CapturedPdfAssets {
    async fetch(input: {
      kind: string;
      filename: string;
    }): Promise<Uint8Array> {
      const folder =
        input.kind === "cMapUrl"
          ? "cmaps"
          : input.kind === "standardFontDataUrl"
            ? "standard_fonts"
            : null;
      if (
        !folder ||
        !/^[A-Za-z0-9_-]{1,150}\.(bcmap|pfb|ttf)$/.test(input.filename)
      )
        throw new Error("DOCUMENT_ASSET_UNAVAILABLE");
      const file = await open(join(root, folder, input.filename), "r");
      try {
        const size = (await file.stat()).size;
        if (size > 2 * 1024 * 1024) throw new Error("DOCUMENT_ASSET_LIMIT");
        const bytes = Buffer.alloc(size + 1);
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== size) throw new Error("DOCUMENT_ASSET_CHANGED");
        return new Uint8Array(bytes.buffer, bytes.byteOffset, size);
      } finally {
        await file.close();
      }
    }
  }
  const task = pdf.getDocument({
    data,
    BinaryDataFactory: CapturedPdfAssets,
    disableWorkerRendering: true,
    enableXfa: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    stopAtErrors: true,
    maxImageSize: 0,
    verbosity: 0,
    cMapUrl: join(root, "cmaps").replace(/\\/g, "/") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts").replace(/\\/g, "/") + "/",
  });
  try {
    const document = await task.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1)
      return unavailableDocument("pdf", "malformed");
    const text = new PreviewText();
    let pagesRead = 0;
    for (
      let pageNumber = 1;
      pageNumber <= Math.min(document.numPages, limits.pdfPages);
      pageNumber++
    ) {
      const page = await document.getPage(pageNumber);
      try {
        if (pageNumber > 1) text.append("\n\n");
        const stream = page.streamTextContent({
          disableNormalization: true,
          includeMarkedContent: false,
        });
        const reader = stream.getReader();
        try {
          while (!text.truncated) {
            const chunk = await reader.read();
            if (chunk.done) break;
            for (const item of chunk.value.items) {
              if (!("str" in item)) continue;
              text.append(item.str);
              text.append(item.hasEOL ? "\n" : " ");
              if (text.truncated) break;
            }
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        pagesRead++;
      } finally {
        page.cleanup();
      }
      if (text.truncated) break;
    }
    return {
      state: "available",
      format: "pdf",
      text: text.value(),
      truncated: text.truncated || pagesRead < document.numPages,
      pagesRead,
      totalPages: document.numPages,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return unavailableDocument(
      "pdf",
      name === "PasswordException"
        ? "encrypted"
        : ["InvalidPDFException", "FormatError"].includes(name)
          ? "malformed"
          : "unavailable",
    );
  } finally {
    await task.destroy();
    if (data.byteLength) data.fill(0);
  }
}
