# ADR 0031: Bounded text extraction from captured documents

Status: implemented private parsing foundation locally for Rasit's review. Separate utility supervision, resource admission, packaging and user-facing preview integration remain required before production use. This ADR does not approve a release.

Subsequent progress: ADR 0032 implements private utility/resource supervision and verifies actual Forge ASAR/native assets. Normal retained-source and Files/Checkpoints integration is still required; the foundation-stage statements below describe the boundary at this decision.

## Context and choice

Captured DOCX/PDF original bytes are already encrypted, hash-verified and recoverable. The UTF-8-only preview does not satisfy the document-preview requirement. We need derived text without rendering captured HTML, invoking Office, following links, executing document actions, or sending content to a provider.

Add private source workspace `@rewind/documents`. It depends only on contracts and pinned parser libraries. The renderer and preload cannot import it. Production callers must run it in a separately supervised Node-capable Electron utility with an external deadline and OS memory limit; it must not parse in main or the existing recording/storage utility. The current app does not import this foundation yet.

- PDF.js `6.5.438` performs selectable-text extraction, never rendering, OCR, annotation/action/JavaScript execution, XFA, system-font discovery or document-URL loading. Input is an owned in-memory copy; original captured bytes are not detached or modified. A custom binary-data factory accepts only bounded font/CMap basenames under trusted installed assets. Worker fetch, WebAssembly, image decoding, font faces and rendering workers are disabled. PDF.js 6 no longer has `isEvalSupported`; the installed main/worker bundles contain no `eval(` or `new Function(`. The supervised process must additionally prohibit string code generation. This is defense in depth, not a claim that a Node utility is an OS security sandbox.
- DOCX uses `yauzl` `3.4.0` for lazy in-memory ZIP enumeration and `sax` `1.6.1` for strict namespace-aware XML. It reads package metadata and the actual nonmacro main document relationship. It extracts body text, paragraph breaks, tabs and line breaks; it ignores images, external relationships, field instructions and deleted text. It does not execute fields, macros or markup, extract files onto disk, or fetch external entities. DTDs and unknown XML entities are refused. A small purpose-built text projection avoids introducing an HTML conversion layer.
- Do not use the archived `saxes` package. `@types/sax` `1.2.7` omits the actual `strictEntities` option; a structurally typed named options value passes the real supported setting without an ambient declaration or unchecked cast. `@types/yauzl` is pinned `3.4.0`.

## Bounds and failure behavior

Contracts define a 16 MiB input limit, 64 KiB UTF-8 output limit, 50 PDF pages, 2,000 ZIP entries, 64 MiB aggregate declared ZIP expansion, 2 MiB main XML, 128 KiB metadata XML, depth 128 and 50,000 XML nodes. Selected ZIP streams also have actual byte limits, size verification and CRC verification. Duplicate/case-ambiguous parts, encrypted entries, unsupported compression, external main relationships, traversal and macro main types are refused. These structural limits alone do not bound every parser allocation; process resource admission is still mandatory.

Available text carries actual format, clipping and PDF page counts. Empty selectable text means empty selectable text, not an OCR result. Password-protected, malformed, unsupported, over-limit, cancelled, timed-out and unavailable states are distinct. Unexpected service failures become unavailable rather than being mislabeled as corrupt source bytes. Recovery must stay available when extraction fails, provided source integrity still verifies. Derived text must remain escaped/plain text in both Files and Checkpoints and must not enter the metadata-only Gemini evidence flow.

No extracted text or temporary document is persisted by this package. Byte buffers are cleared on exit paths where owned. Strings and internal third-party allocations are reclaimed with the isolated process; this is not a forensic memory-erasure claim. Document layouts, images, headers/footers, embedded objects and exact reading order are outside this plain-text projection. All original bytes remain the recovery authority.

## Evidence and remaining integration

Twenty-five synthetic parser tests exercise real stored/deflated ZIPs and real PDF cross-reference offsets, Unicode and literal markup, both Word namespaces, malformed/missing/duplicate bodies, DTD/entity refusal, external/macro main parts, unrelated links, CRC/encryption failures, ambiguous parts, entry/expansion/XML/depth/text limits, password-protected PDFs, empty selectable text, page limits and unchanged original bytes. No personal document or browser activity is used. Initial tests caught a Windows path separator incompatibility in PDF.js asset URLs; trusted asset bases now have forward-slash endings while the bounded factory owns file reads.

Before exposure: supervise a separate parser utility, apply OS allocation limits before sending bytes, prove timeout/cancellation and actual child exit, package the exact PDF worker/font/CMap/native-canvas dependencies, revalidate retained source authority after extraction, invalidate stale previews on privacy/storage changes and verify the real packaged Files/Checkpoints flows. Do not treat these unit tests as that evidence.

## Dependencies and primary sources

Installed metadata identifies PDF.js as Apache-2.0, yauzl as MIT and sax as BlueOak-1.0.0. PDF.js's optional `@napi-rs/canvas` and Windows x64 prebuilt package resolve to `1.1.1` (MIT). They must be packaged and tested without a Python/native source-build fallback; preserve all applicable notices before distribution. A production-only audit on 19 November 2026 reports zero known vulnerabilities; this is a dated package-manager observation, not a security approval. Existing full-tooling audit and license reconciliation gates remain.

- [PDF.js source](https://github.com/mozilla/pdf.js) and [official API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html); installed `pdfjs-dist` types/source are authoritative for the selected version.
- [yauzl documentation](https://github.com/thejoshwolfe/yauzl): lazy entry enumeration, validated entry sizes, from-buffer ownership and bounded stream cancellation.
- [sax documentation](https://github.com/isaacs/sax-js): strict XML, namespaces and XML-only entities.
