# Dependency-ordered development roadmap

## Local implementation progress after audit

See [backend stabilization](backend-stabilization.md) for evidence and [ADR 0009](../decisions/0009-session-lifecycle-stabilization.md) for policy. RWA-001's lifecycle policy and RWA-100's fixture implementation are implemented locally and await normal lead review. RWA-003 gained concurrency/failure and packaged ordering coverage. RWA-102 gained session/activity validation, atomic reference/event writes and stronger prototype readiness; versioned packaged migrations and other relationship work remain. RWA-200 gained corrected existing Windows adapter lifecycle/failure behavior under synthetic strategies; native measurement/host approval remain. RWA-402's prototype query/cursor correctness slice is implemented; FTS/query UI and permission/expiry integration are still future work. These partial slices do not mark the broader roadmap tasks or remote PRs complete.

The next gate is RWA-101 encrypted-storage/key feasibility, followed by RWA-103 utility supervision and durable consent integration. Do not repeat the old lifecycle audit goal or bypass encryption to enable recording.

This roadmap is future work, **not implemented features or authorization to merge/publish**. Rasit approves architecture, contracts, dependencies, security and integration; ownership below preserves the existing team assignments. IDs `RWA-*` are audit follow-ups, not silent replacements for the existing RWD backlog. Effort is focused engineer-days, excluding review, native build uncertainty and student availability. Each major task should be a separate PR unless explicitly split further; dependent contract PRs land first.

Security is an admission gate in every phase. In particular, encrypted real-data storage and explicit revocable permission are Phase 1 prerequisites, not work postponed to Phase 7. Synthetic fixtures are permitted before those gates. A later phase never grants permission to enable an earlier unsafe integration.

## Phase 0 — Stabilization and PR integration

### RWA-000 — Review and adopt bounded audit fixes

- **P1 · Fix · Owner: Rasit**, with Hacer reviewing the renderer guard and Mohammed Bashli reviewing SQL behavior. **Separate PR:** yes; collector-lineage fix is reviewed independently.
- **Objective/modules:** adopt local baseline storage/renderer regressions and assess `e77a066` from collector stabilization; use `packages/storage`, renderer, app tests and audit documents.
- **Dependencies/approach:** inspect cleanup `2f169b9` separately from this audit; carry failure semantics into the selected implementation rather than copying whole old files.
- **Acceptance/tests:** applicable regression tests pass; no consent override, fake durable success or lost caller transaction; type/lint/format/build/app tests pass and source ownership is preserved.
- **Effort:** 0.5–1 day review/integration, excluding blocked PR refactors. Maps to RWD-005 and findings F01/F06–F08/F15/F19.

### RWA-001 — Approve lifecycle, storage mode and shutdown policies

- **P0 · Refactor/design gate · Owner: Rasit. Separate PR:** yes, approved contracts/ADR before dependent changes.
- **Objective/modules:** settle D1/D2 in contracts, engine and architecture docs; collection health must be distinct from active session and durable storage readiness.
- **Dependencies/approach:** use the four coordinator probes; define command serialization, public commit point, partial-start compensation, revocation/drain and quit timeout behavior. Durable failure cannot become volatile success.
- **Acceptance/tests:** complete transition/failure matrix, state publication rules and synthetic acceptance cases reviewed; no UI success when a required operation failed.
- **Effort:** 1–2 days. Maps to RWD-100/103; must precede any dependent product feature.

### RWA-002 — Repair pending PR scope and dependency order

- **P1 · Fix/refactor · Owner: Rasit**, coordinating original module owners. **Separate PRs:** yes, split contracts/storage/UI/collectors/AI.
- **Objective/modules:** make #3/#4/#5/#6 reviewable against the integration plan and preserve useful contributions in their owned files.
- **Dependencies/approach:** RWA-000/001; repair #4 first for its bounded prototype scope, salvage #3 independently, hold #5 runtime and #6 until gates pass. Rebase/split only after owner approval; no blind cherry-picks.
- **Acceptance/tests:** no duplicate inherited integration, precise limitations, refreshed CI, failure tests for each claimed behavior and updated source/contract docs.
- **Effort:** 1–3 days coordination, implementation effort assigned below.

### RWA-003 — Strengthen verification and maintenance inventory

- **P1 · Fix · Owner: Rasit**, each module owner supplying failure cases. **Separate PR:** yes.
- **Objective/modules:** improve `tests`, package tests, CI, dependency/license inventory and official SDK type verification.
- **Dependencies/approach:** preserve good tests; convert relevant known-failure probes into ordinary regressions as fixes land. Separate consented native tests from synthetic CI. Review compatible moderate dependency fixes and clarify MIT/UNLICENSED discrepancy without changing licensing silently.
- **Acceptance/tests:** clean supported Node installation, no masking ambient provider declarations, correct lifecycle/query negative tests, exact package-and-launch checks after dependency changes; no real foreground/browser data in unattended CI.
- **Effort:** 1–3 days initially, ongoing per integration.

## Phase 1 — Reliable sessions, permission enforcement, and local persistence

### RWA-100 — Implement serialized, failure-aware lifecycle using fixtures

- **P0 · Refactor/fix · Owner: Rasit. Separate PR:** yes.
- **Objective/modules:** correct `SessionCoordinator`, preserve deterministic `SessionService`, and apply approved lifecycle contracts.
- **Dependencies/approach:** RWA-001; compute candidate state, serialize commands, check every Result, compensate partial startup, invalidate generations and drain pending ingestion before acknowledgements. Use synthetic ports first.
- **Acceptance/tests:** all four preserved coordinator probes pass; concurrent start/pause/resume/end, save/start/stop failure, append failure, revoked consent and stale callbacks cannot yield false recording success or post-stop writes.
- **Effort:** 2–4 days. Maps to RWD-100/103; no new collector feature in this PR.

### RWA-101 — Prove encrypted SQLite, snapshots and OS-key compatibility

- **P0 · Refactor/design spike · Owner: Mohammed Bashli**, Rasit approving security/dependencies. **Separate PR:** yes, synthetic feasibility only.
- **Objective/modules:** choose the exact DB/FTS5/key/blob boundary for storage and desktop packaging; do not select a binding by ordinary Node success alone.
- **Dependencies/approach:** D3 and existing ADR 0005; compare viable cipher/native distributions, license/maintenance cost and OS-protected key access using generated fixtures.
- **Acceptance/tests:** packaged Windows open/write/reopen, wrong/missing key, tamper, journal/temp/FTS coverage, native ABI/ASAR rebuild and deterministic failure. No plaintext fallback or real personal records.
- **Effort:** 3–7 days, uncertainty high. Maps to RWD-003/500; blocks real history, including internal recording.

### RWA-102 — Stabilize versioned repositories and migration resources

- **P1 · Fix/refactor · Owner: Mohammed Bashli. Separate PR:** yes; contract cursor/source changes separately approved by Rasit.
- **Objective/modules:** repair #4 repository/migration behavior in `db`, storage and query ports.
- **Dependencies/approach:** RWA-000/001; first preserve atomic initialization and row validation, then one authoritative migration manifest with version/checksum policy and packaged resource resolution. Distinguish logical snapshot sizes from actual usage.
- **Acceptance/tests:** corrupt rows, failed/retried upgrade, missing resource, duplicate/future version, rollback ownership, reopen, foreign-key and duplicate IDs; no schema-less open success or dangling evidence.
- **Effort:** 2–4 days. Maps to RWD-102; a fixture-only slice may land before RWA-101, runtime cannot.

### RWA-103 — Compose the supervised utility service and real consent boundary

- **P0 · New infrastructure/refactor · Owner: Rasit**, Mohammad assisting host, Hacer implementing approved consent UI and Abdullah reviewing clarity. **Separate PRs:** host/protocol, consent UI, then integration.
- **Objective/modules:** desktop utility entry/transport, engine authorization, settings scopes, narrow preload and UI status.
- **Dependencies/approach:** RWA-100/101/102; workers start without capture, use versioned bounded messages and fresh generation/consent capabilities; user sees actual off/unavailable/active/durable states.
- **Acceptance/tests:** child ready/crash/hang/restart, malformed messages, partial startup, revocation while writing, no automatic resume, exact sender authorization, truthful disabled controls and packaged entry/resource paths.
- **Effort:** 3–6 days combined. No actual collection until this gate and RWA-200 pass.

## Phase 2 — Activity collection and timeline integration

### RWA-200 — Validate the Windows collector adapter and health model

- **P1 · Fix/refactor · Owner: Mohammad Poorhamadi**, Rasit approving native/health contract. **Separate PR:** yes, spike before replacement.
- **Objective/modules:** `packages/collectors` Windows strategy, utility composition and capability status.
- **Dependencies/approach:** RWA-103; keep PID regression, compare corrected PowerShell with get-windows under explicit opt-in. Measure startup/CPU/latency, normalize bounds and exclude Rewind/private browser title paths conservatively.
- **Acceptance/tests:** synthetic desktop APIs, failure/gaps/retry, stop during query, no consent, excluded process and packaged native ABI; real Windows test is separate and consented. No null-only test is presented as successful capture.
- **Effort:** 2–4 days. Maps to RWD-004/101.

### RWA-201 — Add approved idle/lock and collector shutdown semantics

- **P1 · New feature/fix · Owner: Mohammad Poorhamadi**, Rasit reviewing lifecycle. **Separate PR:** yes.
- **Objective/modules:** collector observations and engine collection gate, without keystroke/screen/clipboard collection.
- **Dependencies/approach:** RWA-100/103/200; approve idle/lock policy, normalize state transitions and produce explicit gaps on unsupported environments.
- **Acceptance/tests:** lock/unlock, idle/active, sleep/wake, rapid pause/end, delayed callbacks, permission revocation and worker restart produce no forbidden events; resources are released before stop acknowledgement.
- **Effort:** 2–4 days; actual Windows capability support requires measurement.

### RWA-202 — Integrate a bounded, evidence-backed timeline

- **P1 · New feature · Owner: Hacer Dilara**, Mohammed Bashli for queries, Abdullah for presentation. **Separate PRs:** query contract and renderer integration.
- **Objective/modules:** timeline read IPC, renderer screen/components and storage query adapter.
- **Dependencies/approach:** RWA-102/103/200; composite cursors, date/session filters, source/time/gap labels and loading/empty/error states. Show actual stored authorized events, not ordinary demo history.
- **Acceptance/tests:** equal timestamps, paging/filter isolation, unavailable data, live updates/unmount/reload, local time/DST formatting, keyboard focus and minimum-window resize. Excluded/expired evidence cannot surface.
- **Effort:** 2–4 days. Maps to RWD-104/302.

## Phase 3 — File capture, versioning, and safe recovery

### RWA-300 — Authorize stable file identity and folder-change signals

- **P0 · Fix/refactor · Owner: Mohammad Poorhamadi**, Rasit owning path authorization and Mohammed identity metadata. **Separate PRs:** approved identity contract, then adapter.
- **Objective/modules:** collectors, engine root/identity validation and file repository; replace random per-notification IDs.
- **Dependencies/approach:** RWA-101/103; canonical allowed roots, component-aware exclusions, reparse/identity checks, scoped watcher registration and reconciliation. Evaluate @parcel/watcher through exact-runtime packaging.
- **Acceptance/tests:** selected/unselected roots, sibling prefixes, traversal/junctions, rapid/atomic saves, rename/delete/recreate, overflow/errors and stop races; watcher metadata never claims a captured version.
- **Effort:** 3–6 days. Maps to RWD-205; D5 approval required.

### RWA-301 — Build verified encrypted original-byte capture

- **P0 · New feature · Owner: Rasit**, Mohammed Bashli owning blob adapter and Mohammad signal integration. **Separate PRs:** blob store, baseline/capture queue, integration.
- **Objective/modules:** engine snapshot orchestration, approved storage blob/metadata ports and bounded extraction workers.
- **Dependencies/approach:** RWA-101/102/300; subscribe before baseline, stabilize reads, hash original bytes, encrypt/verify immutable publication, then commit metadata. Expose baseline/gap status.
- **Acceptance/tests:** initial and later saved bytes, DOCX formatting equality, locked/changing/oversized/unsupported files, tamper/key failure, disk full, duplicate/shared blobs and crash reconciliation. No stale or partial capture success.
- **Effort:** 4–8 days combined. Maps to RWD-200/201; real-data encryption already mandatory.

### RWA-302 — Implement engine-owned safe recovery

- **P0 · New feature · Owner: Rasit. Separate PRs:** proposal/validation, save-copy, then overwrite only after preservation proof.
- **Objective/modules:** engine recovery, approved narrow IPC and storage safety-copy capabilities.
- **Dependencies/approach:** RWA-301 and D5; expiring single-use proposals bound to authorized version/hash/destination/target identity. Save-copy default. Before overwrite, preserve and verify current bytes, then revalidate and publish through a tested Windows operation.
- **Acceptance/tests:** failed preservation, stale/duplicate confirmation, locked/changed/reparsed targets, corrupt source, low disk, interrupted replace and restart leave current contents safe. No assistant execute/confirm capability.
- **Effort:** 4–7 days. Maps to RWD-202; Rasit's explicit design approval precedes implementation.

### RWA-303 — Present real version previews and confirmations

- **P1 · New feature · Owner: Hacer Dilara**, Abdullah owns recovery journey; Rasit approves safety semantics. **Separate PR:** design contract, then UI.
- **Objective/modules:** renderer version/recovery screens, safe preview and approved preload clients.
- **Dependencies/approach:** design can use labeled fixtures after D5; live integration waits for RWA-302. Show captured time/evidence/mode, partial failures and save-copy default; never imply unsaved-state restore.
- **Acceptance/tests:** keyboard/screen-reader confirmation, escape/cancel, expired proposal, unavailable preview, preservation failure and actual success from backend Result. No button reports success before verified completion.
- **Effort:** 2–4 days. Maps to RWD-203/204.

## Phase 4 — Browser integration, search, and checkpoints

### RWA-400 — Prove and implement secure Chrome/Edge transport

- **P0 · New infrastructure · Owner: Mohammad Poorhamadi**, Rasit approving D6. **Separate PRs:** host spike, bounded protocol, metadata integration.
- **Objective/modules:** extension, installed native-host entry, authenticated user pipe and utility ingress.
- **Dependencies/approach:** RWA-103 and D6; exact allowed extension origins, per-user registration, fresh session/generation handshake and bounded nonpersistent buffers. Keep metadata consent distinct from article extraction.
- **Acceptance/tests:** both browsers, missing/wrong host/ID, malformed/oversized/replayed messages, focus/incognito/restricted-page/exclusion behavior, worker termination/reconnect/pause races, installation/update/uninstall cleanup.
- **Effort:** 4–7 days. Maps to RWD-300/301; no port/listener is silently opened.

### RWA-401 — Add permissioned bounded content extraction

- **P1 · New feature · Owner: Mohammad Poorhamadi**, Rasit approving parser/privacy scope. **Separate PRs:** article extraction, document derivatives.
- **Objective/modules:** Readability extension adapter and PDF.js/Mammoth utility jobs, linked to actual captures/visits.
- **Dependencies/approach:** RWA-301/400; per-site gesture/permission, cloned DOM and plain text; preserve original bytes. Bound size/time/memory and isolate malformed documents.
- **Acceptance/tests:** denied/revoked site, private/internal page, scripts/markup, malformed/encrypted/image-only/large documents, parser hang and safe preview; no executable captured HTML or unconsented excerpt.
- **Effort:** 3–5 days. Maps to RWD-307/405; no OCR promise.

### RWA-402 — Build local FTS5 evidence search

- **P1 · Fix/new feature · Owner: Mohammed Bashli**, Hacer query/results UI and Abdullah evidence labels. **Separate PRs:** query correctness/contract, FTS migration, UI.
- **Objective/modules:** storage FTS migrations/indexing, authorized evidence query port, preload and search screen.
- **Dependencies/approach:** RWA-102/202 and source/expiry contracts; repair fabricated/version/session semantics first, then transactional FTS index/backfill/rebuild. Offline keyword/date search remains independent of Gemini.
- **Acceptance/tests:** source resolution, scope/time/latest-version correctness, equal-time pages, malformed query/Unicode/limits, excluded/expired removal, index consistency, loading/errors/keyboard and large-fixture query plans.
- **Effort:** 3–6 days combined. Maps to RWD-400/401.

### RWA-403 — Implement checkpoint manifests, Keep and reviewed reopen

- **P1 · New feature/refactor · Owner: Rasit**, Mohammed Bashli for relationships/pins, Hacer/Abdullah for UI/journey. **Separate PRs:** relational/pin contract, engine, UI.
- **Objective/modules:** checkpoint repositories, engine lifecycle and bounded reopen proposals; no process-memory restore.
- **Dependencies/approach:** RWA-301/302/400, D5 and approved pin/partial-capture policy. Select existing immutable captures or explicitly capture current versions; disclose outcomes and pin transitive artifacts.
- **Acceptance/tests:** missing/expired versions, browser references, cross-session policy, kept session deletion, shared blobs, unkeep/delete, partial capture and individually authorized resource reopen/recovery.
- **Effort:** 3–6 days combined. Maps to RWD-303–306.

## Phase 5 — Gemini assistant and evidence-based recall

### RWA-500 — Implement engine-authorized read-only evidence tools

- **P0 · Fix/refactor · Owner: Rasit. Separate PR:** yes, provider-independent policy layer.
- **Objective/modules:** assistant tools and engine evidence/proposal ports; preserve typed source IDs and evidence limits.
- **Dependencies/approach:** RWA-302/402/403; six planned tools require their real capabilities. Apply permissions/exclusions/expiry before return, validate every model argument/output and keep execute/confirm recovery impossible.
- **Acceptance/tests:** malicious/unknown tools, cross-session/file IDs, excluded/expired results, prompt-injected evidence, bounded dates/counts/bytes and proposal-only recovery. All citations resolve to authorized records.
- **Effort:** 2–4 days. Maps to RWD-402; no cloud integration in this task.

### RWA-501 — Repair SDK compatibility and revocable provider execution

- **P1 · Fix/new feature · Owner: Rasit. Separate PR:** yes, after tool policy and D7 approval.
- **Objective/modules:** #6 service, real SDK declarations, protected key adapter and strict assistant IPC.
- **Dependencies/approach:** RWA-500, explicit cloud opt-in and provider-data disclosure; remove ambient masking with typed consumers, select a supported evaluated model, enforce deadlines/cancellation/concurrency/tool budgets and redact errors.
- **Acceptance/tests:** all four preserved assistant probes pass, no call when disabled/missing key, revoke during tool/request, timeouts abort and clear timers, oversized responses, provider failure and versioned source schema. Mocked network tests precede any separately approved live test.
- **Effort:** 2–4 days. Maps to RWD-403/503; no shared embedded key.

### RWA-502 — Evaluate recall and integrate evidence UI

- **P1 · New feature · Owner: Rasit**, Hacer frontend and Abdullah uncertainty/source design. **Separate PR:** evaluation fixtures then UI.
- **Objective/modules:** assistant evals and renderer command/evidence screens using approved IPC.
- **Dependencies/approach:** RWA-501; use labeled example questions including work at 2 PM, PDF before VS Code, topic-only recall, ambiguous titles and missing capture. Derive insufficient evidence from actual records.
- **Acceptance/tests:** resolvable citations/time links, no invented resources/success, offline local search, cloud disclosure and cancellation, keyboard focus and malformed model output. Record measured recall/latency/cost before selecting defaults.
- **Effort:** 2–4 days. Maps to RWD-404/401.

## Phase 6 — Floating notch UI and mascot integration

### RWA-600 — Specify notch interaction and shared capability roles

- **P1 · Refactor/design gate · Owner: Abdullah**, Hacer implementing specs and Rasit approving D8/security. **Separate PR:** design/contract before UI.
- **Objective/modules:** design specs, dashboard/notch component ownership and window-role capability matrix.
- **Dependencies/approach:** stable RWA-103/202/502 clients; define collapsed/expanded/keyboard modes, command/result scope, dashboard handoff, focus/escape, accessibility/reduced motion and arrow-mascot assets. No parallel backend state.
- **Acceptance/tests:** reviewed screen/state and keyboard/focus specification, role-denial tests defined, no hover-only essential action or invisible typing interception.
- **Effort:** 1–3 days. This audit only proposes it; no notch was built.

### RWA-601 — Implement the authorized Windows overlay and shared frontend client

- **P1 · New feature/refactor · Owner: Hacer Dilara**, Rasit owning main/preload/window roles and Abdullah reviewing motion/mascot. **Separate PRs:** client/roles then overlay.
- **Objective/modules:** desktop window registry, constrained window commands, shared session/query client, independent notch/dashboard views.
- **Dependencies/approach:** RWA-600; top-center work-area DIP positioning, bounded expand/collapse, explicit activation and approved always-on-top/click-through/lifetime policy. Exclude the overlay from collection inference.
- **Acceptance/tests:** unauthorized windows remain denied; both surfaces see one session; monitor hotplug/DPI/taskbar/fullscreen/sleep/wake, pointer/keyboard activation, focus return, screen reader/high contrast and reduced motion. No generic BrowserWindow API crosses preload.
- **Effort:** 3–6 days. Voice remains separate optional work, not implied microphone access.

## Phase 7 — Encryption, privacy hardening, retention, packaging, and final release verification

### RWA-700 — Complete cross-store retention, deletion and quota enforcement

- **P0 · New feature/hardening · Owner: Mohammed Bashli** for queries/accounting, **Rasit** accountable for orchestration; Hacer real settings UI. **Separate PRs:** queries, engine, UI.
- **Objective/modules:** storage/FTS/blobs/pins, engine queues, previews, extension buffers and assistant caches.
- **Dependencies/approach:** basic encrypted storage already passed in Phase 1; RWA-301/402/403/501. Apply configurable 72-hour retention, physical usage/quota and kept-overflow policy atomically/restartably.
- **Acceptance/tests:** expired data absent from all retrieval paths, kept transitive/shared references preserved, restart/low-disk/orphan recovery, revoke/delete during queues and honest UI Result. No provider-log or forensic-erasure promise.
- **Effort:** 4–7 days combined. Maps to RWD-501/502/503.

### RWA-701 — Harden encryption/key/data lifecycle end to end

- **P0 · Hardening/refactor · Owner: Mohammed Bashli**, Rasit security approval. **Separate PR:** yes, split migration/rotation if needed.
- **Objective/modules:** approved encrypted DB/blob/key adapters, migration/recovery/temp handling and redacted diagnostics.
- **Dependencies/approach:** extend Phase 1 proof to every actual artifact, FTS/journal/temp/safety-copy path, key loss/rotation and upgrade behavior. Do not introduce a replacement cipher at release time without review.
- **Acceptance/tests:** missing/wrong key, tamper/truncation, migration interruption, rollback/reopen, temporary plaintext exposure audit, access/retention changes and no silent plaintext fallback.
- **Effort:** 3–6 days. Maps to RWD-500; encryption was never deferred to this phase.

### RWA-702 — Deliver signed Windows distribution and native-host lifecycle

- **P0 · New deployment capability · Owner: Mohammad Poorhamadi**, Rasit approving signing/update policy. **Separate PRs:** installer/host install, update/uninstall.
- **Objective/modules:** Forge packaging/makers/resources, Windows installer/host registration, application icons, extension distribution and release docs.
- **Dependencies/approach:** RWA-400/701, authoritative license/notices and D8; signed per-user install, exact IDs/paths, native ABI checks and authenticated update/rollback strategy.
- **Acceptance/tests:** clean supported Windows install/update/repair/uninstall, both browser registrations, locked files, absent runtime/dependency, revoked/invalid update signature and explicit retain/delete-data choice. ZIP build must not be called an installer.
- **Effort:** 3–6 days. Maps to RWD-504.

### RWA-703 — Run release failure, privacy, performance and UX gates

- **P0 · Verification/hardening · Owner: Rasit**, Abdullah accountable for UX/accessibility review, each owner correcting their module. **Separate PRs:** test/evidence bundle and fixes.
- **Objective/modules:** full application/extension/native integration tests, evals, benchmarks, support/release notices and documentation.
- **Dependencies/approach:** all preceding version-one gates; test the complete consented session, captured-byte recovery and retained/deleted evidence across restarts. Record real capability/support limits and measured resource budgets.
- **Acceptance/tests:** off/pause/lock/revoke/crash/restart/exclusion, storage pressure, overwrite failure, browser/private/native failures, offline/cloud minimization, eight-hour resource scenario, keyboard/contrast/DPI and notch focus. Beta/public checklist approved by Rasit before any publishing.
- **Effort:** 4–8 days initial verification; failures may require further work. Maps to RWD-505/506.

## Next meaningful task per teammate

| Teammate            | Next task                                                                                        | Required handoff                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Rasit               | RWA-001 then RWA-100: lifecycle/storage failure policy and synthetic serialized coordinator.     | Approved state/failure matrix to storage, collectors and frontend; final integration review stays with Rasit.           |
| Hacer Dilara        | Repair #3's API integration/false actions under RWA-002, preserving working baseline.            | Coordinate tokens/disabled states with Abdullah; request new capabilities through Rasit.                                |
| Mohammed Bashli     | RWA-101 encryption feasibility, with RWA-102 migration/query failures against fixtures.          | Exact key/blob/schema boundary and packaged evidence to Rasit; review backend-authored storage PR #4 as module owner.   |
| Mohammad Poorhamadi | Review `e77a066`, then synthetic collector health and native capability measurement for RWA-200. | Provide truthful failure/stop behavior to Rasit; no real collection enabled before consent/utility/encryption gates.    |
| Abdullah            | Specify honest off/unavailable/consent/recovery states and review #3 tokens with Hacer.          | Keep notch/mascot design as a later approved specification; do not conceal missing functionality behind visual success. |

No ownership is reassigned by PR authorship or by this audit. Most urgent pre-feature work is RWA-000–003 and RWA-100–103; subsequent feature work remains blocked on the relevant safety gate, not on finishing attractive UI first.
