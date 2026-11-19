# ADR 0033: Verified retained-document previews in Files and Checkpoints

Status: implemented and verified locally for Rasit's review. The broader goal completion audit and extracted-content search gap remain active; no remote merge, publication or release is authorized.

## Context and choice

ADRs 0031–0032 provide bounded text extraction and a resource-limited, single-use utility. The missing path is the normal app: securely read a captured version, extract outside the recording coordinator, reverify its retained identity/bytes, show derived text safely and cancel stale work without making parsing a recovery prerequisite.

Use the existing typed recording-worker channel for a private relay. Its binary request contains only a boot generation, request UUID, PDF/DOCX format and at most 16 MiB of verified captured bytes. Main validates this private schema directly, without JSON-stringifying byte arrays, then forwards owned bytes to the separately guarded parser. Worker replies carry bounded text and actual closure status. A second private request cannot overlap the first. Public IPC rejects these binary relay types; it continues to accept only explicit capabilities and bounded metadata. No source path, parser path, credential, database key or arbitrary script is accepted from the renderer.

The recording-side client correlates both parse and stop receipts, coalesces concurrent stops and keeps closure unconfirmed after missing/failed acknowledgements. Abort alone cannot prove exit. A newer observed closure cannot be replaced by an older failed stop result. Main also stops parsing on recording-worker failure and requires confirmed document stop before reconnect or acknowledged shutdown. Preview and shutdown requests have deadlines that accommodate the bounded private process lifecycle; heartbeat supervision stays active.

## Source verification and privacy lifecycle

`FileOperations` reads the retained original through encrypted storage's hash-verifying snapshot port inside the coordinator queue. It then releases that queue while the separate utility parses. It re-enters the queue, performs current retention cleanup and rereads/reverifies actual original bytes and immutable version metadata before returning text. Missing/deleted sources and changed/corrupt bytes cannot produce a successful preview. Owned source and transient transport byte copies are cleared on their exit paths; there is no forensic string/heap-erasure claim.

Parser errors are distinct from storage errors: encrypted, malformed, unsupported, over-limit, cancelled, timed-out or unavailable extraction leaves a recoverable original when source verification still succeeds. A corrupt retained source still faults the recording service and revokes authority. Derived text remains ephemeral; current local search indexes recorded metadata and filenames. This change does not persist document body text or add it to Gemini's metadata-only sharing reviews.

Runtime snapshots and preview responses now carry a dedicated document generation/revision receipt. Privacy, storage, checkpoint and relevant session changes synchronously invalidate pending previews. Explicit maintenance quiesces collection first, confirms parser closure, and then mutates storage; a failed close cannot acknowledge successful deletion. Parsing is outside the coordinator, so these stop/delete operations do not wait behind PDF/XML work. A retry or clean restart can complete maintenance after closure is confirmed.

Automatic expiration/quota cleanup has a narrower invalidation scope. Its synchronous pre-commit callback offers an existence check for a selected captured-version ID against the current transaction. `FileOperations` tracks only the active/last displayed source and request IDs. Removing that source invalidates its receipt before commit; deleting unrelated old activity/versions leaves a retained or kept preview usable. This avoids repeatedly clearing every visible document while old history expires. The existence callback expires when the pre-commit callback returns and exposes no raw SQL/database handle. It is not a filesystem authorization token or a substitute for the post-parse hash read. Callback failure rolls back maintenance.

## Public controls and display

The existing `versions.preview(id)` remains usable; normal Files/Checkpoints callers additionally supply their own validated UUID. New `versions.cancelPreview(requestId)` affects only the matching owned active or unconfirmed request. Replacing a preview first observes its owned request closure. Stale close/unmount requests cannot cancel a newer screen's request. Failed closure ownership survives a result and can be retried.

The shared renderer request hook retains the owned ID through display, serializes replacement/cancellation, cancels on unmount, and exposes preparation/cancel controls. Both screens mask a response immediately when its generation/revision differs from current runtime authority; late replies cannot repopulate a cleared view. They render extracted content as React text in the existing `<pre>` styles, with a visible format/limitations notice. DOCX projection contains main-body text; PDF projection contains selectable text with actual page counts. Layout/images/headers/footers and OCR limitations remain explicit. Empty selectable text is an empty result, never invented OCR.

Main's native recovery chooser now requests a private metadata-only `versions.source` summary. Choosing a recovery destination does not invoke PDF/XML parsing or depend on successful extraction. Actual proposal/confirmation still reverify original retained bytes, destination proof and all copy/overwrite prerequisites. Saved copies remain the original byte sequence, including data beyond a clipped preview. Gemini receives no document body/full path and has no recovery authority.

## Verification

The preceding private checkpoint has 522 unit tests, Windows build, 18 packaged app tests, 6 installed-browser tests and the actual-ASAR document harness passing. Integration adds tests for:

- Private binary mediation, public rejection, stale boot IDs, malformed/oversized messages, no byte-array JSON bounds serialization, single-job admission and actual failed-stop/reconnect/shutdown handling.
- Real encrypted DOCX/PDF source reads, plain-text extraction, original/hash preservation, byte corruption during parsing, distinct extraction failures, metadata-only recovery selection, source deletion/expiration during parsing, kept evidence, unrelated cleanup and request-specific cancellation/replacement.
- Normal packaged Files and Checkpoints, actual native selected-folder capture, escaped markup, exact DOCX recovery-copy equality, kept history deletion and restart, actual image-only/password-protected/malformed documents, invalid public argument rejection and cancellation/deletion of a guarded pending request.
- A secondary untrusted Electron window is denied both preview and cancellation through the ordinary preload, alongside the existing privileged capability checks.

The two new packaged document tests pass, and their Files/Checkpoints screenshots were inspected against the existing design. The delayed-request test uses a main-process test-driver interception in a marked synthetic profile, clones only synthetic bytes and clears them when its actual guarded child exits. It adds no production fixture/endpoint/script acceptance path. The separate ADR 0032 harness proves timeout of an actual admitted and confirmed-started infinite-loop process. Final checks pass 557 tests / 64 files, type/lint/format/install metadata, Windows build, 20 packaged app tests, 6 installed-browser tests and the actual-ASAR document harness; the core integration report records scope and limitations.

No personal document, actual desktop activity or personal browser history is captured by these tests. Interactive Gemini credential submission/live-account compatibility, independent security review, licensing and signed distribution remain separate manual/release gates.
