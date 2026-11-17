# Engineering findings

The active [core integration follow-up](core-functionality-integration.md) adds encrypted-history retention, FTS deletion, physical usage/quota backpressure, explicit stop/drain/deletion controls and stricter checkpoint membership. F12 advances through transitive retention and FK/session validation; checkpoint creation and recovery UI remain dependent work. Historical entries below retain their inspected-revision scope.

The next local slice implements bounded original-byte capture and Files UI, advancing F13/F28 with persistent bindings, native current-use scope/identity checks, atomic encrypted bytes and saved-file evidence, source-specific approval, verified text previews and restart tests. Renames/moves, document rendering, recovery execution and checkpoint UI remain separate work. Unicode name separation, retention freshness, preview invalidation and failed-close retry have regressions. This does not repair or merge the old remote collector composition.

## Subsequent implementation status

[Backend stabilization](backend-stabilization.md) and [ADR 0009](../decisions/0009-session-lifecycle-stabilization.md) record local implementation after this audit. F03–F05's coordinator/quit defects are corrected in the selected branch with synthetic concurrency/failure tests. F09's activity cursor and F10's prototype query scope/version references are corrected. F01/F06 fail closed in the selected composition; F07/F08 protections are preserved and extended. F11/F26 now cover validated/sanitized session/activity operations and atomic file-opened references, with broader repository work still pending. F14's existing Windows adapter now drains queries/emits, propagates failures, reports gaps and retries rejected dedup candidates; F15's PID correction is retained. F19's missing-bridge fix is retained and delayed-response races are also corrected. F27/F30 gain corresponding regressions and shared typed registry/storage ports.

The subsequent [secure-storage integration](secure-storage-collection-integration.md) implements F02 metadata/key encryption, utility supervision, durable launch-scoped consent and the functional Windows timeline/search slice. It also checks SQLite/FK/FTS integrity and packaged protected-key failure. These changes are local and do not repair remote PRs automatically. Remaining F12/F13/F17 resource relationships, snapshots, retention/deletion, idle/lock, browser authentication, AI and release gates remain open. Detailed entries below preserve their original revision-specific evidence.

Reviewed 16 November 2026. P0 = critical or blocks release/real-data integration; P1 = high correctness/reliability risk; P2 = medium; P3 = cleanup. A release-blocking missing capability is not a claim that the inactive foundation currently captures data unsafely. Confidence is **reproduced**, **confirmed by code**, **architectural concern**, or **requires measurement**. Effort estimates are focused engineer-days, excluding review and unfamiliar native-build setup.

Revision scope: shared main `0391630`; previous local cleanup `2f169b9`; PR #3 `ba16ceb`, #4 `5824ea1`, #5 `6114324`, #6 `a91d79d`. The latter two inherit #4, and #6 inherits #5. Local fixes are explicitly distinguished from unchanged remote PR heads. [Validation](validation-report.md) includes commands and preserved failure probes.

## Ten highest-priority engineering changes

Ranking weighs privacy/data loss first, then correctness, reliability, blocked dependencies, effort and UX. These are engineering gates, not permission to begin implementing all features.

| Rank | Change / findings                                                                          | Why first                                                                                        | Gate                                                         |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | Enforce default-off consent and truthful collection state, F01/F17/F18                     | Starting an ordinary session must not grant monitoring permission or claim fake privacy actions. | Before merging a recording-enabled app.                      |
| 2    | Fail closed on storage/key failure; select and prove encrypted persistence, F02/F06/F07    | Plaintext or pretend durability would expose or lose personal history.                           | Before any real history writes; approval required.           |
| 3    | Serialize lifecycle transitions and propagate failures, F03/F04                            | A later pause can be undone by an earlier asynchronous start.                                    | Before collector integration or further dependent features.  |
| 4    | Drain ingestion and make shutdown/revocation acknowledged, F05                             | A successful pause/end/quit must mean no later writes from the stopped generation.               | Same lifecycle gate; approval required.                      |
| 5    | Establish the utility-process host and truthful failure supervision, F14/F16/F30           | Current background code is coupled to main and masks capture gaps.                               | Before production collection.                                |
| 6    | Repair source identity, query isolation and pagination, F09/F10/F11                        | Wrong-session results and fabricated version IDs invalidate recall/recovery evidence.            | Before query UI or assistant integration.                    |
| 7    | Authorize canonical file identities and immutable byte capture, F12/F13/F28                | Watcher IDs/metadata cannot recover bytes or authorize paths.                                    | Before snapshot/recovery implementation; approval required.  |
| 8    | Enforce browser/private/article scope end to end, F17/F21                                  | An extension permission or process title alone cannot prove allowed browsing context.            | Before browser capture.                                      |
| 9    | Replace assistant policy/citation/budget shortcuts, F22–F25                                | Off-by-default helps, but enabled operation fails privacy and evidence requirements.             | Keep #6 unintegrated until local evidence/policy gates pass. |
| 10   | Strengthen failure tests and reconcile distribution/dependency/license status, F26/F27/F29 | Green CI currently misses the preceding failures; a ZIP is not an installer/release.             | Before trusting an integration or promising beta readiness.  |

## Detailed findings

### F01 — Composition grants collection consent automatically

- **Severity/category/confidence:** P0, privacy authorization, confirmed by code.
- **Location:** PR #5/#6, `apps/desktop/src/main/main.ts`, `userSettings` assigns `collectionConsent: true` over safe defaults.
- **Evidence/impact:** Ordinary Start/tray commands can start Windows polling without a consent flow while the unchanged renderer says collection is off. Consent and session activity are conflated.
- **Correction:** Use default settings now; later require an engine-issued consent scope independent of session status. **Owner:** Rasit with Hacer/Abdullah for disclosure. **Effort:** 0.25 day for default; 2–4 for policy/UI integration.
- **Risk/fix-now:** Low for removing the override; full consent design needs Rasit's approval. Fixed only on local `audit/collector-stabilization`; remote #5/#6 remain unchanged. No monitoring-enabled app was launched.

### F02 — Real-data composition uses unencrypted storage before approval

- **Severity/category/confidence:** P0, data protection, confirmed by code and missing release capabilities.
- **Location:** #5/#6 `main.ts` startup, `packages/storage/src/sqlite-adapter.ts`; ADR 0005.
- **Evidence/impact:** Opens stock SQLite at userData/rewind.sqlite, with WAL, no cipher/key validation, and no encrypted snapshot implementation. ASAR and content hashes cannot supply encryption. Main baseline does not open this adapter.
- **Correction:** Keep real-data integration disabled; prove an exact encrypted SQLite/FTS5/key/blob combination in packaged Windows using synthetic records. **Owner:** Mohammed Bashli, Rasit approving keys/binding. **Effort:** 3–7 days for feasibility, then scoped implementation.
- **Risk/fix-now:** High data-format/native dependency decision. **Needs Rasit's Approval.** Not implemented or replaced during audit; do not merge #5/#6 as real persistence.

### F03 — Coordinator ignores Result failures and reports success

- **Severity/category/confidence:** P1, lifecycle/durability, reproduced.
- **Location:** #5/#6 `packages/engine/src/session-coordinator.ts`, `execute`, file-reference saves in `handleEmittedEvents`.
- **Evidence/impact:** Synthetic session-save and collector-start errors both yield `ok: true`; service state mutates before persistence and startup. Collector Results and referenced-file save Results are ignored. UI/tray can report success while evidence was not durably recorded.
- **Correction:** Specify prepare/commit/compensate semantics, propagate failures and expose actual capability/gap state. Do not simply throw after publishing an active state. **Owner:** Rasit, collaborating with Mohammed/Mohammad. **Effort:** 2–4 days.
- **Risk/fix-now:** Medium/high, affects lifecycle state and partial rollback policy. **Needs Rasit's Approval** for semantics; preserve probes for a focused implementation goal.

### F04 — Concurrent lifecycle commands can restart collectors after pause

- **Severity/category/confidence:** P0, concurrency/privacy, reproduced.
- **Location:** #5/#6 `SessionCoordinator.execute` has no command serialization.
- **Evidence/impact:** Delay the first session save, issue pause, then finish save: state is paused but all three collector start methods run after pause acknowledged. Repeated start/resume/end have equivalent interleaving risks.
- **Correction:** One serialized lifecycle command stream with immutable operation/generation ownership, failure compensation and ordered publication. **Owner:** Rasit. **Effort:** 2–4 days with F03/F05.
- **Risk/fix-now:** High if patched piecemeal; not fixed during this audit. **Needs Rasit's Approval.** New feature integrations must wait.

### F05 — Pause/end/quit do not establish ingestion quiescence

- **Severity/category/confidence:** P0, shutdown/data consistency, reproduced for pause; quit concern confirmed by code.
- **Location:** #5/#6 coordinator ingestion and `main.ts` asynchronous `before-quit`; `WindowsCollector.pause/stop`.
- **Evidence/impact:** Hold an append Promise: pause resolves while the write is pending. Generation checks happen before the await and there is no in-flight drain. Electron does not await an async event listener merely because it returns a Promise; quit never prevents default and waits for completion. A pending window query also survives stop, although generation checks discard its result.
- **Correction:** Invalidate authorization first, stop sources, drain/cancel bounded work, commit stopped state, then acknowledge. Main must own a guarded asynchronous quit handshake, with documented failure policy. **Owner:** Rasit with Mohammad. **Effort:** 2–4 days.
- **Risk/fix-now:** High; application lifetime/crash semantics need approval. Not changed. Synchronous baseline shutdown is unaffected.

### F06 — Persistent failures become successful volatile repositories

- **Severity/category/confidence:** P1, data loss/error propagation, reproduced.
- **Location:** #5/#6 `SqliteStorageAdapter.open`, `createInMemoryRepositories`, and main's further `:memory:` fallback.
- **Evidence/impact:** A nonexistent parent for a persistent database returns success and exposes Maps. Search returns empty success; validation/order/durability differ from SQL. Closing a Map fallback originally left repositories accessible. Static SQLite imports also mean missing-module failures may occur before fallback lookup.
- **Correction:** Return a structured failure and expose no repositories after persistent failure. **Owner:** Mohammed Bashli, Rasit for runtime policy. **Effort:** 0.5–1 day for narrow correction; broader mode policy belongs with F02/F03.
- **Risk/fix-now:** Low for rejecting persistent-open failure; fixed locally on collector stabilization, including close cleanup. Missing-runtime Map mode remains limited to the existing `:memory:` prototype, not approved release behavior. Main's second fallback and #6 copy still require revision. No broad fallback deletion was performed.

### F07 — Adapter initialization is non-atomic, leaks handles and accepts unusable schemas

- **Severity/category/confidence:** P1, storage integrity/resources, reproduced in baseline; related initialization concerns in #4–#6.
- **Location:** baseline `packages/storage/src/sqlite-adapter.ts`, `open`; #4 default migration lookup; #5 embedded resources.
- **Evidence/impact:** Repeated open discards in-memory state; failed SQL leaves an early CREATE TABLE committed; failed open retains a handle; no-schema open reports success; raw errors include the requested path. #4 can also miss its relative resource after bundling yet expose empty repositories. #5 maintains a third schema copy.
- **Correction:** Idempotent successful open, owned transaction for baseline SQL, required-table check, rollback/close on failure and bounded content-free initialization error. **Owner:** Mohammed Bashli. **Effort:** 0.5–1 day for baseline; 1–2 for versioned packaged migrations.
- **Risk/fix-now:** Low/medium. Seven combined storage regressions were first red; baseline fixes are now green. Empty default database open now deliberately fails; callers must provide migration SQL or a previously initialized database. No desktop integration or new migration framework was added. Carry equivalent corrections into #4 before integrating.

### F08 — Transaction error paths can roll back caller work or reject unexpectedly

- **Severity/category/confidence:** P1, data integrity/error contracts, reproduced.
- **Location:** baseline `activity-repository.ts:append`, `checkpoint-repository.ts:save`; review equivalent rollback handling in #4–#6.
- **Evidence/impact:** BEGIN fails inside a caller transaction, then unconditional ROLLBACK destroys that transaction. With a closed database, rollback itself throws and the Promise rejects instead of returning Result.
- **Correction:** Roll back only a transaction successfully started by that method; preserve the original failure if cleanup fails. **Owner:** Mohammed Bashli. **Effort:** 0.25–0.5 day.
- **Risk/fix-now:** Low, fixed in baseline with three failure-path tests. Nested transactions remain unsupported and correctly return failure; this is not added savepoint support. Existing foreign-key rollback behavior remains tested.

### F09 — Timestamp-only pagination loses equal-time events

- **Severity/category/confidence:** P1, query correctness, reproduced on #5 inherited query implementation; confirmed in baseline/#4/#6.
- **Location:** `SqliteActivityRepository.list/queryTimeline`; shared `before: Timestamp` port; analogous version/checkpoint ordering.
- **Evidence/impact:** Two events sharing a timestamp, page size one: next page uses `< timestamp`, so only one event is ever returned. Current pagination tests use distinct timestamps and miss the loss.
- **Correction:** Add a reviewed composite cursor `(occurredAt, id/sequence)` and deterministic ordering/indexes throughout all paged APIs. **Owner:** Mohammed Bashli, Rasit approving contracts. **Effort:** 1–2 days.
- **Risk/fix-now:** Medium, public cursor change affects consumers; **Needs Rasit's Approval**. Preserve failing probe; do not pretend a sort-only patch fixes the cursor.

### F10 — Search fabricates version references and leaks query scope

- **Severity/category/confidence:** P1, evidence correctness/privacy, reproduced and confirmed by code.
- **Location:** `search-repository.ts` baseline and #4/#5/#6 file query; `COALESCE(fv.id, f.id)` and `fv.session_id IS NULL` in #4.
- **Evidence/impact:** An uncaptured file is returned as a file-version in an unrelated session, with file ID substituted for version ID. Baseline also omits file scope/time and checkpoint time filtering; #4 improves some filters but keeps the fabricated fallback and global-latest selection. Results may not resolve to captured bytes.
- **Correction:** Define file-reference evidence separately or omit uncaptured versions; query the latest authorized version within the requested scope, validate linked IDs and preserve source types. Design FTS5 migration separately; current code uses SQL LIKE, including wildcard behavior and raw JSON/path excerpts. **Owner:** Mohammed Bashli with Rasit. **Effort:** 2–4 days.
- **Risk/fix-now:** Medium, source contract and product semantics need approval. Not replaced with a new search system during audit.

### F11 — Baseline repositories trust typed values and corrupt rows

- **Severity/category/confidence:** P1, boundary integrity, confirmed by code.
- **Location:** baseline row conversion/write methods across all repositories, especially `rowToActivityEvent` type assertion and JSON parsing.
- **Evidence/impact:** TypeScript types do not validate runtime records; malformed discriminators, IDs, hashes, path identity and chronology can enter or be hydrated as domain types. SQL constraints cover only part of the model. Raw parse/database errors are embedded in Result messages.
- **Correction:** Salvage #4's schema-validation approach, use parsed data, test malformed writes/corrupt rows and surface integrity failures without document text. **Owner:** Mohammed Bashli. **Effort:** 1–3 days.
- **Risk/fix-now:** Medium overlap with pending #4; avoid independently rewriting all repositories. Not fixed wholesale here.

### F12 — Checkpoint links and Keep do not enforce retention integrity

- **Severity/category/confidence:** P1, relational integrity, confirmed by schema; retention is a missing capability.
- **Location:** `db/{schema.sql,migrations/001_initial.sql}`, checkpoint repositories in all revisions.
- **Evidence/impact:** Browser-visit junction has no referenced visit foreign key, versions can belong to another session, arrays can duplicate IDs, and session deletion cascades through kept checkpoints. Keep is only a boolean: no transitive retention/blob accounting exists.
- **Correction:** Specify cross-session policy, normalized resource/visit membership, atomic pin accounting and deletion rules before retention integration. **Owner:** Mohammed Bashli, Rasit approving retention semantics. **Effort:** 2–4 days.
- **Risk/fix-now:** Medium/high migration/data-lifecycle decision. **Needs Rasit's Approval.** Do not equate repository round trips with working Keep or recovery.

### F13 — Folder events lack authorized stable resource identity

- **Severity/category/confidence:** P1, filesystem authorization/evidence, confirmed by code.
- **Location:** #5/#6 `FolderCollector.initWatchers/handleFsEvent/emitFileChange/recordFileOpened` and coordinator exclusions.
- **Evidence/impact:** Constructor watchRoots are not checked against protectedFolderIds; each notification invents a fresh file ID without saving its path/reference. String-prefix exclusions overmatch siblings and do not handle canonical roots/reparse points. Errors/overflow are ignored and rename is inferred from existence.
- **Correction:** Treat signals as untrusted hints; authorize canonical scoped identities in engine, reconcile identity/atomic saves, bound queues and explicitly report gaps. **Owner:** Mohammad Poorhamadi, Rasit for authorization, Mohammed for identities. **Effort:** 3–6 days.
- **Risk/fix-now:** High; no filesystem authorization system was invented here. **Needs Rasit's Approval.** Retain normalization concepts; rework live integration.

### F14 — Collector failures and rejected emits disappear

- **Severity/category/confidence:** P1, reliability/status, confirmed by code.
- **Location:** #5/#6 Windows collector lifecycle/poll; folder watcher error handler; coordinator Result handling.
- **Evidence/impact:** Catch blocks return success, watcher errors are empty, failed emit Results are ignored, and Windows dedup state advances before successful persistence. Repeating the same observation may never retry after failure. Tests explicitly bless successful startup with a failing strategy.
- **Correction:** Distinguish unsupported/headless/permission/failure, publish capture gaps and avoid claiming collection active when unavailable. Define bounded retry/dedup only after accepted ingestion. **Owner:** Mohammad Poorhamadi with Rasit. **Effort:** 1–3 days.
- **Risk/fix-now:** Medium; needs agreed collector health contract. Not turned into a new feature during audit.

### F15 — Foreground script assigns read-only PowerShell PID

- **Severity/category/confidence:** P1, Windows correctness, reproduced with a synthetic window.
- **Location:** #5/#6 `packages/collectors/src/window-strategy.ts`, `WINDOWS_POWERSHELL_SCRIPT`.
- **Evidence/impact:** `$pid = 0` conflicts with PowerShell's automatic `$PID` variable; the catch returns no observation. Existing native test expects null/failure, so it does not prove foreground capture works.
- **Correction:** Use a separate typed `[uint32]$foregroundProcessId` for the Win32 out parameter and process lookup. **Owner:** Mohammad Poorhamadi. **Effort:** 0.25 day.
- **Risk/fix-now:** Low; fixed only in collector stabilization. Regression runs the actual script against injected C# methods returning synthetic data; it never queries a real foreground window. Real Windows/native capture remains unverified.

### F16 — Repeated PowerShell startup is a production performance concern

- **Severity/category/confidence:** P2, performance, confirmed mechanism; impact requires measurement.
- **Location:** #5/#6 Windows strategy, 1,000 ms poll and 2,000 ms child timeout; `Add-Type` per process.
- **Evidence/impact:** Each query launches a process and may compile C#; `isPolling` prevents overlapping polls in one instance. CPU/latency/sleep-wake behavior was not benchmarked. No invented resource percentage is asserted.
- **Correction:** Benchmark synthetic/consented harness first, compare get-windows in a utility process, then consider event hooks only if measured need warrants. **Owner:** Mohammad Poorhamadi. **Effort:** 1–2 days measurement plus migration spike.
- **Risk/fix-now:** Medium native/package compatibility change; **Needs Rasit's Approval** for dependency selection. Do not replace the collector during this goal.

### F17 — Browser/article/private-context authorization is incomplete

- **Severity/category/confidence:** P1, privacy, confirmed missing gates; no actual private activity was collected in audit.
- **Location:** #5/#6 BrowserVisitInput, BrowserCollector, coordinator; Windows foreground-title path.
- **Evidence/impact:** Normalizer has global article consent but no per-site permission proof or incognito/focused-tab provenance. Central ingestion does not independently enforce all article/file-change scope. Generic browser process titles may expose private-page titles even with an inactive extension.
- **Correction:** Revoke/drop before ingestion; require authenticated browser context, site-specific extraction scope, query-string policy and a conservative browser-title rule. **Owner:** Mohammad Poorhamadi with Rasit and Hacer/Abdullah. **Effort:** 2–4 days policy/harness work.
- **Risk/fix-now:** High trust-contract change, **Needs Rasit's Approval**. Do not activate browser collection just because a URL validates.

### F18 — PR #3 simulates backend/privacy success

- **Severity/category/confidence:** P1, UX/backend correctness, confirmed by code; packaged CI fails.
- **Location:** #3 renderer `App.tsx:handleAction/handleClearData/useEffect`, `mockBridge.ts`, App.css.
- **Evidence/impact:** Uses wrong `stop`/`onStateChange` names, never hydrates via get, changes local session before engine Result, swallows command errors, defaults visual monitoring to true and reports successful deletion without backend work. Mock writes `window.bridge`, while real API is `window.rewind`. Inline styles conflict with packaged CSP.
- **Correction:** Keep working DesktopApi/session integration; port reviewed CSS tokens only, replace fake actions with unavailable states, use test-only labeled fixtures. **Owner:** Hacer Dilara with Abdullah; Rasit reviews consent semantics. **Effort:** 1–3 days.
- **Risk/fix-now:** Medium conflicting frontend change; do not replace their screen wholesale or merge as-is. Previous cleanup already made baseline future controls honest.

### F19 — Missing preload crashes connection setup

- **Severity/category/confidence:** P2, frontend resilience, reproduced against packaged baseline.
- **Location:** baseline renderer `App.tsx` initial effect dereferenced `window.rewind.sessions` before Promise catch.
- **Evidence/impact:** A sandboxed same-page test window without preload has no connection alert and cannot use the offered retry flow.
- **Correction:** Guard unavailable capability before subscription, show existing disconnected error and keep actions disabled. **Owner:** Hacer Dilara. **Effort:** 0.25 day.
- **Risk/fix-now:** Low, fixed locally and verified with a third packaged-app test, including retry. No UI redesign or new privileged capability added. Broader subscription/get ordering and error-boundary cases remain follow-up tests.

### F20 — Single-window composition needs an explicit overlay authorization design

- **Severity/category/confidence:** P2, architecture/extensibility, architectural concern.
- **Location:** main singleton `mainWindow`, sender authorization/publishState; monolithic renderer.
- **Evidence/impact:** Current handler correctly rejects other windows. A future notch cannot safely be added by accepting every same-origin window; close always quits and broadcasts target one webContents.
- **Correction:** Registered window roles/capability allowlists, shared backend session client, independent dashboard/notch presentation, explicit lifetime policy. **Owner:** Rasit with Hacer/Abdullah. **Effort:** 2–4 days after backend gates.
- **Risk/fix-now:** Medium security/product decision. **Needs Rasit's Approval.** Keep current restrictive authorization until overlay work is approved.

### F21 — Browser transport is not operational

- **Severity/category/confidence:** P1, integration/release gap, confirmed by all extension files.
- **Location:** `apps/browser-extension`, ADR 0004; no executable host/installer/pipe implementation anywhere inspected.
- **Evidence/impact:** MV3 worker sets only action title. No tab/native permissions, transport, site extraction or Chrome/Edge integration exists; internal BrowserCollector does not change this.
- **Correction:** Prove exact-origin per-user Native Messaging host plus authenticated bounded utility ingress, version/generation handshake, reconnect/revocation and install/uninstall. **Owner:** Mohammad Poorhamadi, Rasit approving security. **Effort:** 3–6 days spike, then separate implementation.
- **Risk/fix-now:** High install/security decision; **Needs Rasit's Approval**. No host registration or real browsing added.

### F22 — Assistant can send context after cloud revocation and bypass retrieval policy

- **Severity/category/confidence:** P0 when enabled, cloud privacy, reproduced for revocation and confirmed tool structure.
- **Location:** #6 `GeminiAssistantService.ask`, tools' AssistantToolContext and repository calls.
- **Evidence/impact:** Flip cloudAiEnabled during the first mocked response: second provider request still occurs. Tools receive repositories, no engine permission/exclusion scope; excerpts may contain raw path/URL/JSON text. Narrow length alone does not authorize content sharing.
- **Correction:** Engine-issued scoped evidence access, permission checks before each tool/request, revocation cancellation and approved minimal excerpt selection. **Owner:** Rasit. **Effort:** 2–4 days after local query policy.
- **Risk/fix-now:** High privacy boundary; **Needs Rasit's Approval**. Remains off and unintegrated, no real provider traffic used in audit.

### F23 — Assistant evidence and uncertainty are unsupported

- **Severity/category/confidence:** P1, evidence correctness, reproduced.
- **Location:** #6 service returns `sources: []`; tool narrowing drops source IDs; IPC uses `z.unknown()` sources.
- **Evidence/impact:** Returned tool evidence produces no citations. A confident answer with no tool evidence is marked sufficient because uncertainty is inferred from English substrings. No source-resolution/answer-grounding validation exists.
- **Correction:** Preserve authorized typed source IDs/times and validate answer citations against the actual evidence set; derive no-evidence status from records, not prose. **Owner:** Rasit with Hacer/Abdullah for presentation. **Effort:** 1–3 days.
- **Risk/fix-now:** Medium contract/eval change; approval required. No fabricated citations were added to mask the issue.

### F24 — Tool-loop bounds and timeout cleanup are incomplete

- **Severity/category/confidence:** P1, reliability/resource budgets, reproduced timer retention; other limits confirmed by code.
- **Location:** #6 `ask`, MAX_TOOL_ROUNDS, Promise.race/setTimeout, dispatchTool.
- **Evidence/impact:** A successful request leaves a timeout active. Promise.race does not abort the SDK call; five rounds do not bound function calls per round, concurrent asks, total bytes/tokens or total request time. Timers eventually settle; this is confirmed retained work, not a measured permanent memory leak.
- **Correction:** Clear timers in finally, use supported cancellation, overall deadline and tool/call/payload/concurrency budgets, current-consent checks. **Owner:** Rasit. **Effort:** 1–2 days plus adversarial tests.
- **Risk/fix-now:** Medium behavior/policy changes in unmerged assistant. Documented rather than integrating AI under the audit scope.

### F25 — Ambient SDK shim hides incompatibility; default model is retired

- **Severity/category/confidence:** P1, provider compatibility, reproduced type failure plus official-source confirmation.
- **Location:** #6 `vendor.d.ts`, `gemini-service.ts:TOOL_DECLARATIONS/DEFAULT_MODEL`.
- **Evidence/impact:** Installed SDK is 1.52.0; temporarily excluding vendor.d.ts reveals TS2322 (`string` is not SDK `Type`). Original file was restored. Google's [Gemini 2.0 page](https://ai.google.dev/gemini-api/docs/models/gemini-2.0-flash) says the hardcoded model shut down on 1 June 2026.
- **Correction:** Compile against official types, use typed declarations, remove masking only with corrected consumers, and select a currently supported model through approved evaluation/configuration. **Owner:** Rasit. **Effort:** 0.5–1 day compatibility work, then evaluation.
- **Risk/fix-now:** Medium; changing model alone would not fix privacy/grounding. **Needs Rasit's Approval** for provider/model settings. No Gemini integration or live call performed.

### F26 — Logs and provider errors can expose sensitive context

- **Severity/category/confidence:** P1, diagnostics/secrets, confirmed raw logging paths; possible upstream secret exposure is a risk, not an observed leak.
- **Location:** #5/#6 main startup paths/stacks, Windows strategy/collector warnings, storage errors, #6 assistant catch; REWIND_GEMINI_KEY environment path.
- **Evidence/impact:** Code logs full database/migration paths and raw Error messages/stacks, and returns provider messages over IPC. Environment keys are privileged but are not OS-protected key lifecycle or a shipping credential UI.
- **Correction:** Structured bounded operational codes, redacted diagnostics, generic public errors, opt-in support bundle; OS-protected credentials before enabling cloud. **Owner:** Rasit with subsystem owners. **Effort:** 1–2 days policy/adapters.
- **Risk/fix-now:** Low for generic errors, medium for credentials. Baseline adapter initialization error is sanitized now; broader diagnostics/key design is pending approval. No credential values were printed or committed.

### F27 — Passing tests/CI do not prove claimed capabilities

- **Severity/category/confidence:** P1, verification quality, confirmed by new failing probes and test inspection.
- **Location:** collector/coordinator tests, storage search tests, #6 assistant tests, `.github/workflows/ci.yml`, app tests.
- **Evidence/impact:** Existing tests cover happy transitions, unique-time pagination, fabricated file-version evidence, mocked foreground success and cloud disabled. They do not cover enabled provider loop, persistence failure, lifecycle races or native browser capture. The native Windows strategy test expects failure/null. Several database fixtures originally never closed handles.
- **Correction:** Keep valuable tests, add public failure scenarios and synthetic Windows stub; separate real consented native tests from unattended CI; cover withheld capabilities explicitly. **Owner:** Rasit for final suite, each module owner for regressions. **Effort:** 2–4 days across modules.
- **Risk/fix-now:** Low for focused regression additions. Audit adds seven storage tests, one packaged resilience test, two isolated collector tests and ten preserved known-failure probes; closes baseline fixture handles. No existing expectation was weakened to hide a defect.

### F28 — Recoverable byte capture and safe execution do not exist

- **Severity/category/confidence:** P0 for recovery/release claims, capability gap confirmed across contracts/code/branches.
- **Location:** FileVersion/RecoveryProposal contracts, SQL metadata, folder events; no snapshot/blob/recovery engine implementation.
- **Evidence/impact:** No original-byte store, stable baseline capture, hash-verified publication, key service, expiry/single-use proposal authorization or preserved-current overwrite exists. Data models alone cannot restore documents.
- **Correction:** Follow the [capture/recovery design](architecture-improvement-plan.md) and dependency order; never present watcher events as saved versions. **Owner:** Rasit, Mohammed Bashli for store, Mohammad for signals, Hacer/Abdullah for confirmation. **Effort:** multiple separately reviewed milestones, roughly 10–20 focused engineer-days combined after prerequisites.
- **Risk/fix-now:** High data-loss design. **Needs Rasit's Approval.** No recovery or snapshot feature implemented in this goal.

### F29 — Distribution, dependency and license readiness are unresolved

- **Severity/category/confidence:** P2 maintenance / release-blocking gates, confirmed configuration and command evidence.
- **Location:** Forge config, manifests/lockfile, LICENSE, docs/dependencies-licenses.md, CI.
- **Evidence/impact:** ZIP maker only; no signed installer/updater, host registration, uninstall policy, release icons/notices or clean-machine evidence. Local package is about 386 MB, not an invented lightweight claim. Root audit reports 11 moderate findings; old Electron in main/PRs also reports one high. LICENSE is MIT but manifests/docs claim unselected/UNLICENSED.
- **Correction:** Reconcile owner-approved license, patch compatible tooling in separate verified work, choose signed per-user distribution/update/data-removal policy and test clean Windows. **Owner:** Rasit, Mohammad for packaging. **Effort:** 1–2 days maintenance; 3–6 days packaging spike.
- **Risk/fix-now:** Medium supply-chain/product policy; **Needs Rasit's Approval**. No license, dependencies, repository rules or release settings changed by this audit. Earlier local Electron patch remains preserved.

### F30 — Boundaries are mostly sound, with drift and incomplete lint enforcement

- **Severity/category/confidence:** P2, architecture/maintainability, confirmed imports/configuration.
- **Location:** #5 coordinator duck-typed collectors; #6 assistant manifest; duplicate BrowserVisitInput and SQL; root lint rules.
- **Evidence/impact:** Coordinator casts registry implementations to unknown records to discover extra methods. Assistant declares a storage dependency although its code needs repository ports from contracts. A renderer stdin lint probe using bare `fs` passed before correction despite the intended Node restriction; the sandbox still prevents Node access at runtime. Relative cross-package directions also need stronger enforcement. Storage adapter's import from its own index is type-only, not a demonstrated runtime cycle.
- **Correction:** Keep monorepo; define approved narrow ingestion/query ports, deduplicate types/schema ownership, enforce import graph incrementally and split App only when behavior is covered. **Owner:** Rasit with module owners. **Effort:** 1–3 days scoped refactors.
- **Risk/fix-now:** Low for adding Node's built-in module names to the existing renderer rule; fixed locally and the same probe now fails as intended. Full package/port contract changes are medium risk and **Need Rasit's Approval**. No framework, global state dependency, monorepo rewrite or large refactor introduced.

## Remaining test and decision implications

Review chronology constraints for browser visit end times and recovery proposal expiry, linked browser-event session IDs, duplicate checkpoint IDs, and path provenance when the corresponding engine operations arrive. These are **architectural validation concerns**, not authorization guarantees that can be supplied by a single schema refine. Do not silently expand public contracts during the audit.

The documented unimplemented retention, quota, parsing, encryption, native transport and recovery gates are not resolved by the small stabilization commits. The next goal must address F01–F06 as one reviewed lifecycle/storage policy slice, with background collection still disabled until authorization and encryption prerequisites pass.
