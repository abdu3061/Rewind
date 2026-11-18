import { describe, expect, it } from "vitest";
import {
  documentPreviewLimits as limits,
  documentTextSchema,
} from "@rewind/contracts";
import { extractDocumentText } from "./index";
import { PreviewText } from "./text";
import {
  docxEntries,
  pdfFixture,
  wordNs,
  zipFixture,
} from "./fixtures.test-support";

describe("captured DOCX text", () => {
  it.each([false, true])(
    "extracts real ZIP/XML with deflate=%s without changing original bytes",
    async (deflate) => {
      const bytes = zipFixture(
        docxEntries(
          "<w:p><w:r><w:t>Sample &amp; 😀</w:t><w:tab/><w:t>&lt;img src=x onerror=alert(1)&gt;</w:t><w:br/><w:t>End</w:t></w:r></w:p>",
        ).map((entry) => ({ ...entry, deflate })),
      );
      const original = Buffer.from(bytes);
      const result = await extractDocumentText("docx", bytes);
      expect(result).toEqual({
        state: "available",
        format: "docx",
        text: "Sample & 😀\t<img src=x onerror=alert(1)>\nEnd\n",
        truncated: false,
        pagesRead: null,
        totalPages: null,
      });
      expect(bytes.equals(original)).toBe(true);
    },
  );
  it("supports strict Office namespaces and omits field instructions/deleted text", async () => {
    const bytes = zipFixture(
      docxEntries(
        "<w:p><w:r><w:instrText>HYPERLINK https://invalid.example</w:instrText><w:delText>Deleted</w:delText><w:t>Visible</w:t></w:r></w:p>",
        { namespace: "http://purl.oclc.org/ooxml/wordprocessingml/main" },
      ),
    );
    expect(await extractDocumentText("docx", bytes)).toMatchObject({
      state: "available",
      text: "Visible\n",
    });
  });
  it("accepts an empty body as actual empty text", async () => {
    expect(
      await extractDocumentText("docx", zipFixture(docxEntries(""))),
    ).toMatchObject({ state: "available", text: "", truncated: false });
  });
  it.each([
    {
      label: "missing body",
      xml: `<w:document xmlns:w="${wordNs}"/>`,
      reason: "malformed",
    },
    {
      label: "duplicate body",
      xml: `<w:document xmlns:w="${wordNs}"><w:body/><w:body/></w:document>`,
      reason: "malformed",
    },
    {
      label: "mismatched tags",
      xml: `<w:document xmlns:w="${wordNs}"><w:body></w:document>`,
      reason: "malformed",
    },
    {
      label: "wrong namespace",
      xml: '<w:document xmlns:w="urn:fake"><w:body/></w:document>',
      reason: "malformed",
    },
    {
      label: "DTD",
      xml: `<!DOCTYPE document [<!ENTITY stolen SYSTEM "file:///C:/private.txt">]><w:document xmlns:w="${wordNs}"><w:body><w:t>&stolen;</w:t></w:body></w:document>`,
      reason: "unsupported",
    },
    {
      label: "HTML entity",
      xml: `<w:document xmlns:w="${wordNs}"><w:body><w:t>&nbsp;</w:t></w:body></w:document>`,
      reason: "malformed",
    },
  ])("rejects $label", async ({ xml, reason }) => {
    expect(
      await extractDocumentText(
        "docx",
        zipFixture(docxEntries(xml, { raw: true })),
      ),
    ).toEqual({ state: "unavailable", format: "docx", reason });
  });
  it.each([
    { target: "https://invalid.example/a", mode: "External" },
    { target: "../private.xml" },
    { type: "application/vnd.ms-word.document.macroEnabled.main+xml" },
  ])("refuses external/traversing/macro main parts %j", async (options) => {
    expect(
      (await extractDocumentText("docx", zipFixture(docxEntries("", options))))
        .state,
    ).toBe("unavailable");
  });
  it("ignores external images and links without fetching them", async () => {
    const entries = docxEntries(
      "<w:p><w:r><w:t>Only saved main text</w:t></w:r></w:p>",
    );
    entries.push({
      name: "word/_rels/document.xml.rels",
      text: '<Relationships><Relationship TargetMode="External" Target="https://invalid.example"/></Relationships>',
      deflate: false,
    });
    expect(
      await extractDocumentText("docx", zipFixture(entries)),
    ).toMatchObject({ state: "available", text: "Only saved main text\n" });
  });
  it("rejects CRC corruption and encrypted ZIP entries", async () => {
    const entries = docxEntries("");
    expect(
      await extractDocumentText(
        "docx",
        zipFixture(entries.map((entry) => ({ ...entry, crc: 1 }))),
      ),
    ).toMatchObject({ state: "unavailable", reason: "malformed" });
    expect(
      await extractDocumentText(
        "docx",
        zipFixture(entries.map((entry) => ({ ...entry, flags: 1 }))),
      ),
    ).toMatchObject({ state: "unavailable", reason: "encrypted" });
  });
  it("rejects ambiguous duplicate part names", async () => {
    const entries = docxEntries("");
    entries.push({
      name: "WORD/document.xml",
      text: "ambiguous",
      deflate: false,
    });
    expect(
      await extractDocumentText("docx", zipFixture(entries)),
    ).toMatchObject({ state: "unavailable", reason: "malformed" });
  });
  it("bounds entry count, declared expansion and XML depth", async () => {
    const entries = Array.from({ length: limits.zipEntries + 1 }, (_, id) => ({
      name: `part${id}`,
      text: "",
    }));
    expect(
      await extractDocumentText("docx", zipFixture(entries)),
    ).toMatchObject({ state: "unavailable", reason: "limit" });
    const declared = zipFixture([
      {
        name: "part",
        text: "a",
        deflate: true,
        declared: limits.zipDeclaredBytes + 1,
      },
    ]);
    expect(await extractDocumentText("docx", declared)).toMatchObject({
      state: "unavailable",
      reason: "limit",
    });
    const nested =
      "<w:p>".repeat(limits.xmlDepth) + "</w:p>".repeat(limits.xmlDepth);
    expect(
      await extractDocumentText("docx", zipFixture(docxEntries(nested))),
    ).toMatchObject({ state: "unavailable", reason: "limit" });
  });
  it("bounds actual XML bytes and returns an honest clipped UTF-8 preview", async () => {
    const oversized = zipFixture(
      docxEntries(`<w:t>${"x".repeat(limits.xmlBytes)}</w:t>`),
    );
    expect(await extractDocumentText("docx", oversized)).toMatchObject({
      state: "unavailable",
      reason: "limit",
    });
    const result = await extractDocumentText(
      "docx",
      zipFixture(
        docxEntries(`<w:p><w:r><w:t>${"😀".repeat(17000)}</w:t></w:r></w:p>`),
      ),
    );
    expect(result).toMatchObject({ state: "available", truncated: true });
    if (result.state !== "available") throw new Error("expected text");
    expect(Buffer.byteLength(result.text)).toBe(limits.textBytes);
    expect(result.text.endsWith("😀")).toBe(true);
    expect(result.text).not.toContain("�");
  });
});

describe("captured PDF text", () => {
  it("extracts real PDF pages, preserving the captured original", async () => {
    const bytes = pdfFixture(["First synthetic page", "Second <img src=x>"]);
    const original = Buffer.from(bytes);
    const result = await extractDocumentText("pdf", bytes);
    expect(result).toMatchObject({
      state: "available",
      format: "pdf",
      pagesRead: 2,
      totalPages: 2,
      truncated: false,
    });
    if (result.state !== "available") throw new Error("expected text");
    expect(result.text).toContain("First synthetic page");
    expect(result.text).toContain("Second <img src=x>");
    expect(bytes.equals(original)).toBe(true);
  });
  it("reports empty selectable text without inventing OCR", async () => {
    expect(await extractDocumentText("pdf", pdfFixture([""]))).toMatchObject({
      state: "available",
      text: "",
      pagesRead: 1,
    });
  });
  it("refuses password-protected input and malformed data", async () => {
    expect(
      await extractDocumentText("pdf", pdfFixture(["sealed"], true)),
    ).toMatchObject({ state: "unavailable", reason: "encrypted" });
    expect(
      await extractDocumentText("pdf", Buffer.from("%PDF-1.7\ninvalid")),
    ).toMatchObject({ state: "unavailable", reason: "malformed" });
    expect(
      await extractDocumentText("pdf", Buffer.from("not a pdf")),
    ).toMatchObject({ state: "unavailable", reason: "malformed" });
  });
  it("limits pages with explicit truncation", async () => {
    const bytes = pdfFixture(
      Array.from({ length: 51 }, (_, page) => `Synthetic page ${page + 1}`),
    );
    const result = await extractDocumentText("pdf", bytes);
    expect(result).toMatchObject({
      state: "available",
      pagesRead: 50,
      totalPages: 51,
      truncated: true,
    });
    if (result.state !== "available") throw new Error("expected text");
    expect(result.text).toContain("Synthetic page 50");
    expect(result.text).not.toContain("Synthetic page 51");
  });
});

describe("preview bounds", () => {
  it("clips by UTF-8 bytes across fragments without splitting codepoints", () => {
    const text = new PreviewText();
    text.append("a".repeat(limits.textBytes - 3));
    text.append("😀after");
    text.append("ignored");
    expect(text.truncated).toBe(true);
    expect(text.value()).toBe("a".repeat(limits.textBytes - 3));
  });
  it("refuses oversized input before parsing", async () => {
    expect(
      await extractDocumentText("pdf", new Uint8Array(limits.inputBytes + 1)),
    ).toMatchObject({ state: "unavailable", reason: "limit" });
    expect(await extractDocumentText("docx", new Uint8Array())).toMatchObject({
      state: "unavailable",
      reason: "limit",
    });
    expect(
      await extractDocumentText("docx", Buffer.from("broken zip")),
    ).toMatchObject({ state: "unavailable", reason: "malformed" });
  });
  it("validates result byte bounds", () => {
    expect(
      documentTextSchema.safeParse({
        state: "available",
        format: "pdf",
        text: "😀".repeat(17000),
        truncated: false,
        pagesRead: 1,
        totalPages: 1,
      }).success,
    ).toBe(false);
  });
});
