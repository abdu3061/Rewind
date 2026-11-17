# Core functionality integration

17 November 2026. Work in progress on `feature/core-functionality`, based on `715dfbe`. The working tree was clean at branch creation. Existing branches, ignored audit worktrees, teammate contributions and Git configuration are preserved. Nothing is pushed, merged, registered, released or deployed.

## Requested scope and evidence standard

The active goal covers privacy/retention/quota, real file capture, safe recovery/checkpoints, Chrome/Edge transport and real frontend integration. Gemini is conditional on those gates. This report tracks the complete scope; a completed storage slice does not complete the overall goal. Automated tests use generated data and isolated marked profiles, never personal files or browsing history.

## Privacy and storage implementation

- Typed storage usage/settings/cleanup/confirmed-deletion commands traverse the existing authorized recording IPC, validated preload and bounded supervised worker. No generic filesystem/SQL/key capability is added.
- Retention runs on startup, before timeline retrieval and every minute while open. Settings persist across restart. Expired metadata and FTS entries are deleted transactionally; encrypted WAL checkpointing and compaction are checked.
- Usage reports actual database/WAL/SHM bytes and record counts. Oldest unkept evidence is evicted under pressure. Kept artifacts remain; insufficient remaining space denies further recording rather than silently deleting pins. Temporary write/compaction overhead is explicitly outside the hard-cap claim.
- Explicit maintenance stops/drains sources, pauses an active session and revokes approval before acknowledgement. Deletion can target one session or all evidence and requires a literal confirmation; kept evidence needs separate inclusion. Session date/status shells and privacy settings remain.
- Migration 004 establishes real visit foreign keys and rejects wrong-session/version/visit membership. Existing SQL migrations remain unchanged. Checkpoint input/hydration is validated and touched errors are sanitized.
- Settings now has real retention/usage/quota/cleanup/deletion controls, explicit confirmation/cancel and truthful failure reporting. No forensic-erasure promise is made.

See [ADR 0012](../decisions/0012-retention-and-snapshot-storage.md) for policy and limits.

## Verification so far

Retention slice: `npm run check` passed TypeScript, ESLint, formatting, install metadata and **180 tests across 26 files**. `npm run build` passed Windows x64 packaging. `npm run test:app` passed **10 packaged tests** against the rebuilt executable. The focused maintenance/runtime run passed 14 tests. No dependency or lockfile change was required.

New storage tests cover exact expiration boundary, FTS disappearance, settings/reopen, kept transitive versions, explicit deletion inclusion, wrong-session/dangling checkpoint rollback, deletion scope, injected SQL deletion failure, physical WAL accounting and quota eviction followed by encrypted reopen. Existing wrong-key/tamper/plaintext/corrupt-schema/worker-failure tests remain intact. The new packaged test exercises confirmed deletion against a live changing synthetic source and verifies no refill plus restart persistence.

Additional regressions verify timer-driven expiry without a timeline query, a revoke superseding a grant while it checks storage, uncollectable quota overhead preserving pins, and busy compaction reporting failure followed by successful retry. Initial packaged assertions still expected disabled preview controls and looked for Dashboard-only status while on Settings; these were corrected to exercise the newly implemented controls and actual navigation. The larger encrypted quota fixture exposed repeated small-batch VACUUM work; eviction now estimates a larger batch and limits compaction to three quota rounds per call. A 30-second stress-test budget accommodates native encryption/fixture creation under load; the focused corrected run finished in 9.6 seconds overall.

The installed pinned cipher amalgamation was inspected: VACUUM attaches its temporary database through the codec's inherited-key handling (SQLite `sqlite3mcHandleAttachKey`, NULL key case); temporary SQL storage remains forced to memory. Reopen/ciphertext tests cover the resulting database and journals. This source review is not an independent cryptographic certification or an OS swap/dump guarantee.

## Remaining scope

Protected-folder capture, original-byte storage, verified text previews and confirmed new-file recovery copies are implemented in the slices below. Checkpoint creation/manage UI, browser transport/registration/consent and browser timeline/search still require implementation and verification. Overwrite needs proven Windows handle/preservation/concurrency semantics; no overwrite is currently exposed. Gemini remains off and unavailable until its prerequisites pass. Idle/lock, installer/signing, licensing and independent security review remain separate release gates.

## File foundation under integration

Migration 005 adds immutable encrypted original-byte BLOBs, protected-folder identities, file/path bindings and version source identities. Capture publication writes bytes, metadata and a file-change observation in one checked transaction, with authorization checks before work and before commit. SHA-256 is verified on publication and retrieval; identical consecutive versions are deduplicated while a return to earlier bytes creates a new version. Shared blobs survive until their last retained version disappears. Only versions backed by actual blobs are listed as recoverable; older metadata-only prototypes are excluded. Quota admission reserves conservative physical headroom before storing new bytes.

The Windows adapter compiles a C# helper once per protection run. It verifies a fixed NTFS volume, obtains actual volume/file identities, compares final handle paths, rejects reparse points/hardlinks and holds ancestor handles without delete sharing. Original-byte reads deny writer/delete sharing and verify identity/size/write-time again. Limits are 16 MiB per file, 240-character local paths, 2,000 enumeration entries and 16 directory levels; network/other filesystems and hidden/build trees are conservatively unsupported. These are actual native Windows tests against generated files, not a claim of integrated automatic capture yet.

Seven encrypted snapshot tests cover byte equality/restart, deduplication, transactional failure/revocation rollback, hash/root/session/identity rejection, corrupt captured bytes, metadata-only exclusion, transitive shared-blob retention/deletion, quota admission and equal-time paging. Four native Windows tests cover exact binary reads/stable identities, an open writer, hardlinks, directory junctions, oversized files, a replaced selected directory, ignored trees, maximum-size reads and in-flight cancellation.

The maximum-size test reproduced a V8 stack overflow in a repeated-quartet base64 regex. A linear character validation plus canonical decode/re-encode check fixes it; all four native tests then passed. This foundation is not registered as a collector or exposed to the renderer yet; selection/consent, automatic capture and frontend version/recovery flows remain active work.

Foundation verification: `npm run check` passed **191 tests / 28 files**, install metadata, TypeScript, lint and formatting. Windows build and all **10 packaged tests** passed after migration 005 was added. These packaged tests establish that the existing encrypted recording/settings/deletion flow survives the new schema; they do not yet exercise folder capture in Electron. The local retention commit is `9a264e6`; the file foundation follows as a separate reviewable local commit.

## Protected-folder integration

The foundation commit is `007dc9e`. The next slice registers real file capture, with separate launch approval, native folder selection, persistent folder/file identities, automatic baseline/save reconciliation, atomic encrypted publication, version paging and verified UTF-8 previews. Main owns dialogs; public APIs accept IDs and explicit choices, never arbitrary source paths. Migration 006 adds filename FTS alongside existing activity search. The initial observation uses `captured`, avoiding a claim that an existing file was created at baseline time. See [ADR 0013](../decisions/0013-protected-folder-capture.md).

Worker integration uses actual Windows file access against generated files: Windows foreground approval remains off, initial and changed bytes persist, pause/revoke stop later captures, and restart retains folders/versions with file permission off. Unit regressions cover source-specific permission, pending preparation drain, failed/inconsistent publication, helper close retry/coalescing, source stop after failed publication, Unicode filename separation, fresh verification of unchanged bytes before expiry and safe file repository hydration/errors.

The final protected-folder quality run passed **204 tests / 29 files**, TypeScript, ESLint, formatting and install metadata checks. Windows packaging passed, and the rebuilt executable passed **11 app tests**, including the real Files dialog/approval/session/capture/search/preview/pause/revoke/restart flow. The screenshot was reviewed: existing styles are preserved and captured text is rendered escaped; no recovery is claimed by this slice. Tests also prove that a new capture after restart resolves the original persistent file ID. Source reads never derive a path from a foreground title.

At the capture commit, limits remained explicit: brief intermediate saves may be missed; fixed NTFS, bounded local paths/files/trees only; locked/reparsed/oversized inputs fail or are skipped; arbitrary moves/renames are not correlated. DOCX/PDF rendering/extraction remains pending. Metadata-only legacy observations cannot be previewed as captured bytes. The subsequent copy-recovery slice is recorded below; browser transport, checkpoints, overwrite and conditional Gemini remain active goal work, not completed milestones.

## Confirmed recovery copies

The protected-folder integration is committed locally as `c353441`. The subsequent recovery slice adds a pure engine service for metadata-only, five-minute, single-use review proposals; a worker-only native destination preparation command; validated choose/confirm/cancel preload capabilities; native save dialog ownership in main; and a real Files preview recovery UI. It adds no dependency, registry entry or remote service. AI has no confirmation or execution capability.

Confirmation consumes the proposal, re-reads currently retained, hash-verified encrypted bytes and compares selected metadata before writing. Cancellation/expiry/reuse/deletion/corruption cannot authorize a copy. Wall and monotonic expiry are checked again after asynchronous verification. At most eight proposals and one active recovery operation are held. Mutable byte buffers are wiped after preparation/confirmation. No raw path is accepted by public renderer commands. Source labels are presentation only, never authorization.

The native adapter revalidates selected parent/ancestor identity, NTFS/path/reparse/sharing constraints, verifies the input hash, uses exclusive `CREATE_NEW`, flushes and reads back the exact bytes and verifies output identity/hash/size. Existing/racing destinations fail without replacement. Failed writes attempt deletion by newly created handle. A crash/timeout can leave a partial **new** file; failures say so, and no atomic overwrite/transaction guarantee is made. Shutdown kills/observes helpers and drains pending work before closing storage. An unobserved prior helper prevents another native write. Export receipts report a verified operation, not invented captured identities or perpetual tracking.

Copies are ordinary files outside Rewind's encrypted storage, may contain active document formats and are never opened/executed automatically. Retention and history deletion do not delete these user-selected copies. Synthetic tests restrict destinations to the marked generated profile. See [ADR 0014](../decisions/0014-confirmed-recovery-copies.md).

Final recovery-copy verification passed `npm run check`: install metadata, TypeScript, lint, formatting and **215 tests / 31 files**. `npm run build` passed Windows x64 packaging; the rebuilt executable passed **11 packaged tests**, including cancellation before creation, explicit earlier-version recovery, existing-destination rejection and unchanged current source bytes. Native tests additionally cover exact binary/full 16 MiB output, traversal, invalid hashes, replaced parents and junctions. Worker tests capture actual bytes into encrypted storage, recover via the actual Windows writer, then delete a reviewed source and prove confirmation creates nothing. Monotonic expiry and late-verification expiry are covered. The screenshot was inspected: escaped captured text, truthful existing-file rejection and the ordinary-file export warning use existing styles. No personal files, real browsing, registry installation or external writes were used in verification.

Milestone 3 remains incomplete: optional overwrite needs durable verified preservation and a proven concurrency/crash strategy; named checkpoint creation, evidence selection and management remain active work. Browser integration and conditional Gemini remain pending. This report preserves those requirements rather than treating successful copy recovery as completion of the full goal.
