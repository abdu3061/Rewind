import { crc32 } from "node:zlib";
import { posix } from "node:path";
import { parser as xmlParser, type QualifiedTag } from "sax";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import {
  documentPreviewLimits as limits,
  type DocumentText,
} from "@rewind/contracts";
import { DocumentFailure, PreviewText, rejectDocument } from "./text";

const packageNs =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const contentNs =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const wordNamespaces = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const mainTypes = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
]);
function attributes(tag: QualifiedTag): Record<string, string> {
  return Object.fromEntries(
    Object.values(tag.attributes)
      .filter((attr) => !attr.uri)
      .map((attr) => [attr.local, attr.value]),
  );
}
function parseXml(
  bytes: Buffer,
  open: (tag: QualifiedTag, depth: number) => void,
  close?: (tag: QualifiedTag) => void,
  text?: (value: string) => void,
): void {
  let value: string;
  try {
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return rejectDocument("malformed");
  }
  // sax supports this option; its separately maintained types omit it.
  const options = {
    xmlns: true,
    strictEntities: true,
    position: false,
  };
  const reader = xmlParser(true, options);
  let depth = 0,
    nodes = 0;
  const stack: QualifiedTag[] = [];
  reader.onerror = () => rejectDocument("malformed");
  reader.ondoctype = () => rejectDocument("unsupported");
  reader.onsgmldeclaration = () => rejectDocument("unsupported");
  reader.onopentag = (raw) => {
    const tag = raw as QualifiedTag;
    if (
      ++depth > limits.xmlDepth ||
      ++nodes > limits.xmlNodes ||
      Object.keys(tag.attributes).length > 128
    )
      rejectDocument("limit");
    stack.push(tag);
    open(tag, depth);
  };
  reader.onclosetag = () => {
    const tag = stack.pop();
    if (!tag) return rejectDocument("malformed");
    close?.(tag);
    depth--;
  };
  reader.ontext = (data) => {
    if (++nodes > limits.xmlNodes) rejectDocument("limit");
    text?.(data);
  };
  reader.oncdata = (data) => {
    if (++nodes > limits.xmlNodes) rejectDocument("limit");
    text?.(data);
  };
  reader.write(value).close();
  if (depth || !nodes) rejectDocument("malformed");
}
function partName(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return rejectDocument("malformed");
  }
  if (!decoded || decoded.length > 1024 || /[\\\0:?#]/.test(decoded))
    return rejectDocument("unsupported");
  const name = posix.normalize(decoded.replace(/^\//, ""));
  if (name.startsWith("../") || name === ".." || name.startsWith("/"))
    return rejectDocument("malformed");
  return name;
}
async function archive(
  bytes: Uint8Array,
): Promise<{ zip: ZipFile; entries: Map<string, Entry> }> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) =>
        error || !zip ? reject(new DocumentFailure("malformed")) : resolve(zip),
    ),
  );
  try {
    const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
      const entries = new Map<string, Entry>();
      let declared = 0,
        count = 0;
      zip.on("error", () => reject(new DocumentFailure("malformed")));
      zip.on("entry", (entry: Entry) => {
        try {
          declared += entry.uncompressedSize;
          if (++count > limits.zipEntries || declared > limits.zipDeclaredBytes)
            rejectDocument("limit");
          const name = partName(entry.fileName).toLowerCase();
          if (entries.has(name)) rejectDocument("malformed");
          if (entry.generalPurposeBitFlag & 1) rejectDocument("encrypted");
          if (![0, 8].includes(entry.compressionMethod))
            rejectDocument("unsupported");
          entries.set(name, entry);
          zip.readEntry();
        } catch (error) {
          zip.close();
          reject(error);
        }
      });
      zip.once("end", () => resolve(entries));
      zip.readEntry();
    });
    return { zip, entries };
  } catch (error) {
    zip.close();
    throw error;
  }
}
async function read(
  zip: ZipFile,
  entry: Entry | undefined,
  maximum: number,
): Promise<Buffer> {
  if (!entry) return rejectDocument("malformed");
  if (entry.uncompressedSize > maximum) return rejectDocument("limit");
  const stream = await new Promise<import("node:stream").Readable>(
    (resolve, reject) =>
      zip.openReadStream(entry, (error, stream) =>
        error || !stream
          ? reject(new DocumentFailure("malformed"))
          : resolve(stream),
      ),
  );
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > maximum) {
        bytes.fill(0);
        rejectDocument("limit");
      }
      parts.push(bytes);
    }
    const result = Buffer.concat(parts);
    if (size !== entry.uncompressedSize || crc32(result) !== entry.crc32) {
      result.fill(0);
      return rejectDocument("malformed");
    }
    return result;
  } catch (error) {
    if (error instanceof DocumentFailure) throw error;
    return rejectDocument("malformed");
  } finally {
    stream.destroy();
    for (const part of parts) part.fill(0);
  }
}
/** Pure memory parsing only. Production must call from the supervised preview utility. */
export async function extractDocx(bytes: Uint8Array): Promise<DocumentText> {
  const { zip, entries } = await archive(bytes);
  let relations: Buffer | undefined,
    types: Buffer | undefined,
    document: Buffer | undefined;
  try {
    relations = await read(
      zip,
      entries.get("_rels/.rels"),
      limits.metadataXmlBytes,
    );
    let target: string | null = null;
    parseXml(relations, (tag, depth) => {
      if (
        depth === 1 &&
        (tag.local !== "Relationships" || tag.uri !== packageNs)
      )
        rejectDocument("malformed");
      if (depth !== 2 || tag.local !== "Relationship" || tag.uri !== packageNs)
        return;
      const attrs = attributes(tag);
      if (
        ![
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
          "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
        ].includes(attrs.Type ?? "")
      )
        return;
      if (
        target ||
        !attrs.Target ||
        (attrs.TargetMode && attrs.TargetMode !== "Internal")
      )
        rejectDocument("unsupported");
      target = partName(attrs.Target!);
    });
    if (!target) return rejectDocument("malformed");
    const main = target as string;
    types = await read(
      zip,
      entries.get("[content_types].xml"),
      limits.metadataXmlBytes,
    );
    let matchingType = false;
    parseXml(types, (tag, depth) => {
      if (depth === 1 && (tag.local !== "Types" || tag.uri !== contentNs))
        rejectDocument("malformed");
      if (depth !== 2 || tag.local !== "Override" || tag.uri !== contentNs)
        return;
      const attrs = attributes(tag);
      if (
        attrs.PartName &&
        partName(attrs.PartName).toLowerCase() === main.toLowerCase()
      ) {
        if (matchingType || !mainTypes.has(attrs.ContentType ?? ""))
          rejectDocument("unsupported");
        matchingType = true;
      }
    });
    if (!matchingType) return rejectDocument("unsupported");
    document = await read(
      zip,
      entries.get(main.toLowerCase()),
      limits.xmlBytes,
    );
    const preview = new PreviewText();
    let textDepth = 0,
      depth = 0,
      bodyDepth = 0,
      sawBody = false;
    parseXml(
      document,
      (tag, current) => {
        depth = current;
        if (
          current === 1 &&
          (tag.local !== "document" || !wordNamespaces.has(tag.uri))
        )
          rejectDocument("malformed");
        if (!wordNamespaces.has(tag.uri)) return;
        if (tag.local === "body" && current === 2) {
          if (sawBody) rejectDocument("malformed");
          sawBody = true;
          bodyDepth = current;
        }
        if (!bodyDepth) return;
        if (tag.local === "t") textDepth = current;
        if (tag.local === "tab") preview.append("\t");
        if (tag.local === "br" || tag.local === "cr") preview.append("\n");
      },
      (tag) => {
        if (wordNamespaces.has(tag.uri)) {
          if (tag.local === "p" && bodyDepth) preview.append("\n");
          if (tag.local === "t" && depth === textDepth) textDepth = 0;
          if (tag.local === "body") bodyDepth = 0;
        }
        depth--;
      },
      (text) => {
        if (textDepth && depth >= textDepth) preview.append(text);
      },
    );
    if (!sawBody) return rejectDocument("malformed");
    return {
      state: "available",
      format: "docx",
      text: preview.value(),
      truncated: preview.truncated,
      pagesRead: null,
      totalPages: null,
    };
  } finally {
    relations?.fill(0);
    types?.fill(0);
    document?.fill(0);
    zip.close();
  }
}
