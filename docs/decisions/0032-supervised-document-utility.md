# ADR 0032: Admit document parsing to a resource-limited utility

Status: private utility composition implemented locally for Rasit's review. Normal Files/Checkpoints integration, retained-source lifecycle checks and packaged preview acceptance remain in progress. This does not authorize remote publication, merge or release.

Subsequent progress: ADR 0033 connects and tests the normal retained-source and Files/Checkpoints flows. The private-stage scope below records this decision's original checkpoint; the core implementation report has the latest validation.

## Decision

Do not invoke ADR 0031's parsing package in main, renderer or the recording/database worker. Main supervises a separate, single-use Electron Node utility. Its private protocol accepts a request UUID, an explicit PDF/DOCX format and at most 16 MiB of original bytes; it accepts no source path, URL, database key, credential or script. Replies carry bounded validated text and the same request identity/format. There is no renderer capability for this protocol.

The process gets a 192 MiB V8 heap setting and disabled string code generation. Its entry validates those flags and its environment policy. Main passes only Windows runtime locations and `DISABLE_SYSTEM_FONTS_LOAD=1`; it does not inherit provider keys, Node options/module injection or canvas native-binding/WASI overrides. The canvas dependency otherwise discovers installed and per-user fonts even when PDF.js's system-font option is false, so both gates are necessary. Native and parser diagnostics are drained rather than logged as user evidence.

Before sending any document bytes, main starts the precompiled `RewindDocumentGuard.exe`. The guard accepts only its actual parent's PID and that parent's direct child PID, holds real process handles, checks creation ordering, matching parent/child executable images, user SIDs and Windows sessions, and refuses stale or unrelated identities. It creates an unnamed, noninherited Windows Job Object, assigns the waiting child and reads back the configured limits and membership before returning a fixed ready marker.

The job limits committed memory to 512 MiB per process and in total, allows one active process, limits user CPU time to 15 seconds and kills its member when the sole job handle closes. This bounds allocations outside V8's heap. It is a committed-memory limit, not a working-set target or filesystem quota. A helper stdin close, parent exit or 30-second helper lifetime closes the job. Failure to configure/verify/assign the job leaves extraction unavailable; there is no unguarded parsing fallback.

Main imposes a 12-second total wall deadline, including startup/admission. Timeout, cancellation, guard loss and malformed/premature/mismatched replies terminate the child and close the guard. Successful text is also withheld until both actual child exit and guard closure are observed. Shutdown/stop wait up to two seconds; lack of observed exit reports failure and keeps the job busy. A second job cannot overlap a surviving process or an admission that has not actually closed. Cancellation arriving after a reply but before observed closure still prevents publication. Owned transport bytes are cleared after structured cloning and on failure paths; original caller bytes remain unchanged.

These limits are containment for resource/lifecycle failures, **not an OS filesystem/network sandbox**. A Node-capable utility retains OS capabilities. The application only supplies memory input and bounded trusted font/CMap files, does not execute document actions or follow document URLs, and depends on reviewed parser implementations. Independent security review remains a release gate.

## Build/runtime assets

Forge bundles `document-entry.cjs` as a distinct main-target entry. The document Vite config explicitly externalizes both prefixed and unprefixed Node built-ins and the PDF.js runtime. This matters for ZIP dependencies importing `stream`/`fs` without `node:`. A real utility test initially reproduced Vite's browser-compatibility stub failure; preserving the Node imports fixes it.

Build-time asset generation uses the existing Windows Framework64 C# compiler and checks that output directories/files do not redirect or share another file. It creates the guard under `.generated/documents` and packages it as `resources/documents`. There is no runtime helper compiler, Python or native source-build fallback.

`copyDocumentRuntime` checks exact installed versions before copying PDF.js's main/worker modules, CMaps, standard fonts and license; canvas JavaScript/license; and the Windows x64 Node-API binary, ICU data and package SBOM. ASAR explicitly unpacks native binaries and ICU data. Dynamic PDF.js loading resolves relative to the bundled module, supporting both test ESM and Forge's CJS output. Copying/building these assets does not grant collection, register hosts or send documents anywhere.

## Verification and remaining work

- Fifteen supervisor tests exercise delayed admission, owned byte transport, admission failure, timeout/abort/guard loss, actual child/helper exit fences, failed-close retry, no overlapping job, late admission, cancellation after reply, wrong request/format, oversized/inconsistent/malformed/premature replies and a child that never spawns.
- Two actual native-process tests compile the helper in an isolated temporary fixture, deny an invalid parent claim, prove that a 640 MiB allocation is refused under the 512 MiB cap, and observe parser termination when the guard pipe closes. CPU/process limit configuration is verified by the helper's readback; these tests do not benchmark every limit.
- An actual Electron test uses a marked temporary synthetic profile, copied runtime assets, the real helper and separate real utilities for DOCX and PDF. It verifies extracted known text, unchanged original PDF bytes and closed supervision. A separate synthetic infinite-loop utility confirms admission and that execution started before the external wall deadline terminates it; both process closures must be observed.
- `npm run build` passes, and `npm run test:documents:packaged` runs that same integration harness against the actual Forge ASAR entry, packaged guard, unpacked native canvas/ICU data and packaged PDF.js ESM worker/assets. It passes with both formats and the confirmed-started hang. This verifies packaged private parsing, not ordinary user-facing previews.
- An environment regression verifies the explicit allowlist and canvas font gate. Parser tests remain the 25 cases in ADR 0031. The full utility checkpoint passes 522 tests / 62 files plus type/lint/format/install checks; the strengthened real hang-start assertion also passes in the focused Electron utility test.

Still required before claiming ordinary previews work: bounded private recording-worker/main binary mediation, source retention/integrity revalidation after extraction, synchronous privacy/storage invalidation, cancellation/drain without blocking the coordinator, escaped Files/Checkpoints rendering and preview expiry/refresh, recovery metadata independent of slow parsing, and actual packaged UI verification including malformed/timeout/restart/deletion behavior. No extracted document content may enter the metadata-only Gemini sharing flow.

## Primary references

- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process): Node-capable child process, message ports, executable arguments, environment and observed exit.
- [Windows extended job limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information) and [basic job limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information): committed-memory, process/CPU and kill-on-close semantics.
