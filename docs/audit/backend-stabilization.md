# Backend stabilization implementation

16 November 2026. Branch: `feature/backend-lifecycle-stabilization`, based on audit commit `99e9b30`. This is an implementation follow-up to the historical audit, not another audit or authorization to merge. See [ADR 0009](../decisions/0009-session-lifecycle-stabilization.md) for the chosen failure/commit/drain policy.

Local source commits: `874a5ba` (storage/contracts and scoped evidence), `99c473f` (existing Windows adapter lifecycle/failures), and `1df9346` (coordinator, desktop shutdown, response ordering and regression/integration coverage). Documentation follows in its own commit. None was pushed or merged.

## Delivered behavior

The session coordinator now serializes commands and checked persistence/collector work, publishes only committed state, compensates partial startup, invalidates stale authority, drains work before successful stop acknowledgement and closes storage only after cleanup. It owns initialization and conservative restart hydration. Failed operations and rejected Promises return structured errors instead of successful active/paused/ended states. Deadlines retain uncertain work until actual settlement.

The desktop uses that coordinator in explicit **session-only** mode. Its narrow preload, sandbox, sender/frame/location checks and public session methods remain compatible. It has no database, native collector or cloud composition, and no failure path switches it into an implicit fixture mode. Quit now uses an acknowledged asynchronous guard. A small renderer correction prevents older command/hydration responses from replacing newer session events.

Repository-mode integration is implemented and exercised against the existing SQLite prototypes using generated records/files only. It is ready for owner review and later host composition; it does not authorize writing personal history to stock SQLite.

## Source integration and ownership

- Adapted `SessionCoordinator` from collector lineage `51913ca` / PR #5 `6114324`, preserving injected ports and the pure SessionService. Introduced prepare/commit, checked storage lifecycle, compensation, bounded ingestion, copied policy and acknowledged drain.
- Adapted the existing WindowsCollector/window strategy from that lineage. Retained its polling/strategy design and PID correction; fixed startup failures, pending-query/emit shutdown, stale-context identity, deduplication, failure gaps and sensitive diagnostics. It is exported as an **unintegrated prototype**; desktop never imports/registers it.
- Applied the useful PR #4 validation approach narrowly to session/activity repositories while retaining the audit's owned rollback protection. Reused existing SQL and file-reference writes; no embedded schema, Maps adapter, main-process SQLite startup, or legacy runtime fallback was copied.
- Corrected related prototype query defects without introducing FTS or assistant work. Existing search tests now create a real synthetic version and verify its source ID resolves, instead of blessing a fabricated reference.
- Preserved the audit, cleanup, collector and teammate branches/worktrees. No merge, push, remote PR, comment, branch deletion, license/dependency change or deployment occurred. Rasit retains integration approval; storage, collector and renderer ownership still require their usual review.

## Requirement-to-evidence map

| Goal                                  | Implementation                                                                   | Direct verification                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start/pause/resume/end/shutdown       | Prepared SessionService + serialized SessionCoordinator; QuitGuard               | Full lifecycle, duplicate actions, overlapping start/stop, partial startup, stop retry, close retry, quit coalescing and executable quit/relaunch     |
| Storage failures never become success | SessionStorage open/load/save/close Results; compensation; no fallback           | Failed open, rejected/corrupt load, rejected writes, actual SQLite triggers, missing persistent parent, unavailable repositories, failed close        |
| Consent and stale-event safety        | Immediate invalidation, immutable run identity, copied settings, resource gates  | No-consent start, repeated generation strings, old contexts, revoke during append/resource authorization, policy mutation, queued work after pause    |
| Complete cleanup                      | Tracked deadlines, source stop, in-flight drain, late-start restop               | Held append, held query, held emit, timed-out startup/append, failed shutdown and later successful retry; storage not closed while work is uncertain  |
| Repository integrity                  | Parsed input/rows; active-session check; atomic file reference/event write       | Mixed invalid batch, paused-session append, corrupt JSON/chronology, duplicate rollback, missing file ID, foreign-key/caller-transaction failure      |
| Related evidence defects              | Composite cursor; scoped latest actual versions; bounded literal keyword query   | Equal-time enumeration, uncaptured/wrong-session files, session/date-scoped versions, checkpoint dates, wildcard/invalid-limit/unsupported-mode tests |
| Existing Windows adapter              | Serialized start/stop; readiness probe; accepted-only dedup; capture gaps        | Injected query/emit races and failures, real adapter + SQLite integration; actual PowerShell script uses synthetic C# APIs only                       |
| Frontend compatibility                | Same DesktopApi/SessionState; validated async dispatcher; newer-event precedence | Existing packaged isolation/navigation/disconnection tests plus deterministic delayed-response fixtures and concurrent commands/restart               |

## Validation record

Host: Windows x64, Node **22.16.0**, npm **11.7.0**. Root dependencies were reused; no installation or lockfile change was needed.

| Stage / command                                           | Actual result                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline `npm run check`, before implementation           | Passed types, lint, formatting and **56 tests / 10 files**                                                                           |
| Original coordinator with four preserved audit probes     | **4 failed**, reproducing ignored save/start failures, late startup after pause and missing append drain                             |
| New storage integrity regressions before correction       | **9 failed**; invalid sessions/events, corrupted rows, stopped-session writes, reference/event atomicity and missing file identities |
| Related search regressions before correction              | **5 failed**; invented versions, scope, checkpoint time, wildcard handling and unsupported/invalid requests                          |
| Composite-cursor regression before implementation         | **1 failed**; same-time events could not be enumerated                                                                               |
| Existing Windows collector with new failure probes        | **4 failed**; missing consent, false startup success, unacknowledged query shutdown and failed-emission dedup                        |
| Storage usage regression before correction                | **1 failed**; unopened adapter reported successful usage                                                                             |
| Packaged delayed hydration regression before renderer fix | **Failed**, newer paused event overwritten by delayed active response                                                                |
| Packaged delayed command regression before renderer fix   | **Failed**, newer ended event overwritten by delayed active response                                                                 |
| Intermediate complete quality check                       | Passed types/lint/format and **129 tests / 17 files**                                                                                |
| Final `npm run check`                                     | Passed types, lint, formatting and **133 tests / 17 files**                                                                          |
| Final `npm run build`                                     | **Passed**: typecheck, inactive extension build, Forge Windows x64 packaged folder                                                   |
| Final `npm run test:app`                                  | **6 passed** against that rebuilt package                                                                                            |

Two initial new packaged runs reached quit/relaunch correctly but failed an off-label locator: first the wording differed; then an exact match included descendant paragraph text. The test now locates the visible sidebar message correctly. A generated-fixture cleanup initially triggered `no-unsafe-finally`; moving scoped cleanup validation into a helper fixed the test hygiene error. These are recorded failures, not hidden product successes. SQLite/glob/color environment warnings were non-failing.

Final review expanded revocation to a multi-resource batch and reproduced one interim bug: a second authorization callback still ran after revocation, although writes were rejected. A per-event authority check now prevents it. Review also reproduced an existing database reporting ready with correct table names but missing columns; readiness now checks all columns used by the prototypes before committing migration/open success. Both regressions passed after correction.

The four coordinator and two query acceptance invariants have been promoted into ordinary regression coverage. Their old text probes remain historical evidence for the recorded PR revisions. The old timestamp-only probe was deliberately adapted to the new composite cursor; timestamp-only arguments remain time boundaries. The four enabled-assistant probes remain unresolved and outside this goal.

## Findings and roadmap status

| Findings / tasks             | Local result                                                                                                                | Remaining boundary                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| F03–F05, RWA-001/100         | Lifecycle policy implemented, checked, serialized and drained; quit handshake implemented                                   | Final owner review; future utility crash/transport integration must preserve these guarantees         |
| F01/F06, RWA-000/103         | No default consent or fallback in selected composition; repository initialization fails closed                              | Remote #5/#6 unchanged; real consent UI/settings and encrypted host still gated                       |
| F07/F08/F11/F26, RWA-102     | Prototype readiness/rollback preserved; session/activity validation, atomic file links and sanitized touched errors added   | Full versioned migration manifest/resources and other repository/relationship validation remain       |
| F09/F10, RWA-402             | Activity composite paging and prototype evidence/scope defects corrected                                                    | Pending PR consumers must adopt the cursor; FTS/query IPC/expiry policy remain future work            |
| F14/F15/F27/F30, RWA-003/200 | Existing Windows fixture lifecycle/failure behavior corrected, PID regression retained, typed registry/storage ports shared | Native capture/health/resource measurements, folder adapter and browser integration remain unverified |
| F19 / frontend consistency   | Missing-bridge fix retained; delayed-response races corrected                                                               | Broader UI/accessibility review and pending PR #3 repairs remain                                      |

These statuses apply only to this local branch. They do not declare the full broad roadmap tasks complete, approve remote PRs or turn a prototype into a recording product.

## Remaining blockers and next goal

Real recording is still disabled. Before any personal history: prove an approved encrypted SQLite/FTS5/key design, then implement the utility-process host/supervision, durable consent/exclusion/settings boundary and authorized native adapters. Resource authorization currently denies browser/file events unless an engine policy port is explicitly supplied; no canonical filesystem or private-browser implementation is invented here. Native polling performance, idle/lock, numbered packaged migrations, retention/pins, actual byte capture/recovery and browser transport remain separate milestones. Gemini and the notch were not integrated.

Port deadlines are cooperative and cannot interrupt blocking synchronous SQLite/native code; that is another reason repository mode must not be wired into desktop main. Actual process-crash/hang supervision and real native/private-browser proof still require the approved utility/runtime milestone. The current tests do not certify those capabilities.

Recommended next goal: **RWA-101, a synthetic packaged Windows encrypted-storage/key feasibility slice**, followed by RWA-103 host/consent integration. Preserve this coordinator and its failure tests as acceptance gates. Keep capture off, evaluate and review the exact binding/key format before adoption, and verify missing/wrong-key, tamper, WAL/temp/FTS coverage and reopen failures. Do not substitute stock SQLite or a successful memory adapter for that proof.

Final consistency checks found no missing targets in 98 local Markdown links and no obvious credential/private-key markers in the 51 changed files (pattern scan only). The packaged ASAR main exactly matches the current build, explicitly selects session-only mode and contains no SQLite, native polling or provider runtime composition markers. ASAR inspection initially needed Windows path normalization; the corrected inspection passed. Git whitespace checks passed. No runtime code changed after the final package/test pass.
