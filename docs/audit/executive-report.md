# Rewind engineering audit report

**Follow-up completed locally:** [Backend stabilization](backend-stabilization.md) implements the former next goal in section J and related verified backend repairs. Use that report for current changes, remaining gates and the next encrypted-storage feasibility goal. The A–J report below remains the original audit snapshot, including the remote revisions it examined.

16 November 2026. Start with this report, then use the [current-state inventory](current-state.md), [30 findings and ranked top ten](findings.md), [architecture plan](architecture-improvement-plan.md), [roadmap](development-roadmap.md), [PR integration plan](pr-integration-plan.md) and [actual validation record](validation-report.md).

## A. Executive summary

Rewind is **a runnable foundation, with partially implemented subsystems on unmerged branches**. It is suitable for internal testing of the shell and in-memory session lifecycle using synthetic data. It is not ready for recording real work sessions, a limited beta or public release.

The current stack and broad module split are appropriate for the five-person team and should be kept. The central problems are unsafe integration semantics and unproven privacy/durability, not a need to rewrite Electron or the monorepo. CI passes on several incomplete branches because its tests miss required failure paths. The audit reproduced those failures instead of trusting PR descriptions.

No new product feature, Gemini integration, recovery engine, overlay, database technology, merge, push or release was added. Source changes are bounded stabilization on local branches. Original teammate implementations and the earlier local cleanup branch remain preserved.

## B. Major findings

1. PRs #5/#6 hardcode collection consent, open stock unencrypted SQLite in main and can contradict the renderer's collection-off claim.
2. The coordinator ignores storage/collector Results. A controlled start/pause interleaving starts all collectors after pause acknowledges; in-flight append can outlive pause. Async quit is not an awaited shutdown protocol.
3. Persistent-open failures become successful volatile Maps. Baseline adapters also lost state on repeated open, left partial migrations/handles and rolled back caller transactions on BEGIN failure.
4. Search returns invented file-version IDs and wrong-session uncaptured files; timestamp-only pagination skips equal-time events. Row validation and checkpoint/pin relationships remain incomplete.
5. Folder events invent fresh IDs, lack canonical protected-root/reparse authorization and do not preserve bytes. There is no capture/recovery engine, encrypted store or working retention/deletion.
6. PR #3 uses wrong preload methods, simulates session/privacy/deletion success and conflicts with packaged styling policy.
7. PR #6 lacks effective mid-request revocation, citations, reliable insufficient-evidence behavior and complete request budgets. Its SDK shim masks a real type error, and its default model has been retired according to [Google's current page](https://ai.google.dev/gemini-api/docs/models/gemini-2.0-flash).
8. The extension is intentionally inactive. Native browser transport, installer/signing/update/uninstall, release key management and the future notch are not implemented or verified.

The [ranked ten](findings.md#ten-highest-priority-engineering-changes) prioritize consent, encrypted fail-closed persistence, serialized/drained lifecycle, utility supervision and truthful evidence before new dependent features or visual polish.

## C. Work completed in this goal

| Change                                                                                                          | Files                                                                                                         | Evidence                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idempotent prototype open, schema readiness, atomic SQL, failed-open cleanup and sanitized initialization error | `packages/storage/src/sqlite-adapter.ts` and test                                                             | Four adapter regressions failed before correction and passed afterward. Empty default DB deliberately fails; no desktop DB integration.                                                    |
| Owned transaction rollback and structured failure on closed DB                                                  | `activity-repository.ts`, `checkpoint-repository.ts` and tests                                                | Three regressions failed before correction and passed afterward; existing foreign-key rollback test retained.                                                                              |
| Close repository test handles                                                                                   | Five storage repository test files                                                                            | Full root suite passes; generated fixture cleanup is path-scoped.                                                                                                                          |
| Honest disconnected UI when preload is unavailable                                                              | `apps/desktop/src/renderer/App.tsx`, `tests/app/session.spec.ts`                                              | Packaged regression failed before guard; three packaged tests pass after rebuild, including retry and unauthorized-window rejection.                                                       |
| Close bare Node-import lint bypass                                                                              | `eslint.config.mjs`                                                                                           | Renderer stdin importing `fs` passed before correction and is rejected afterward; normal renderer imports remain covered by full lint/build checks.                                        |
| Isolated collector-lineage consent, PID and persistence failure correction                                      | Local `audit/collector-stabilization`, safety commit `e77a066`, follow-up deterministic test commit `51913ca` | Before/after synthetic regressions; final full worktree check passes **88 tests in 15 files**, no skips or real foreground calls. [Portable patch](patches/collector-stabilization.patch). |
| Evidence and planning                                                                                           | All `docs/audit` documents, manifest, patch and preserved probes                                              | Fresh GitHub/read-only branch inspection; ten expected safety probes fail on target code and are retained as text for future fixes.                                                        |

Root baseline: 49 unit tests and 2 app tests. Stabilized root: 56 unit tests and 3 rebuilt packaged-app tests. Build passes. The collector branch was not package-launched; the assistant branch used mocked SDK calls only. Audit finds 11 moderate dependencies in root and one additional high finding on old-Electron PR branches. Root dependencies were reused; two new isolated worktrees installed their exact lockfiles once.

Earlier scaffold removal, mock-screen cleanup and Electron patch `2f169b9` predate this goal; they are reviewed context, not counted as new audit fixes. No dependencies, source license, existing Git configuration or GitHub settings were changed in this goal.

Baseline fixes are saved on `audit/stabilization-2026-11-16` in `a75b263` (storage) and `7123796` (renderer/lint). Collector-lineage fixes are separate commits `e77a066` and `51913ca`. The documentation commit follows the baseline fixes; none of these commits was pushed or merged.

## D. Work that must be redone

- **Rework** coordinator lifecycle orchestration and runtime composition around candidate/commit state, checked Results, serialized operations, acknowledged draining and utility supervision. Retain its injectable ports and some normalization tests.
- **Replace the unsafe runtime behavior** of successful persistent fallback, raw sensitive logging and hardcoded consent. Synthetic fixtures remain useful; they must never masquerade as durable recording.
- **Refactor** file/query identity and checkpoint relationships. Random change IDs, fabricated versions, unscoped references and Keep booleans are unsuitable as recovery/retention guarantees.
- **Revise** PR #3 interactions using the actual bridge; keep reviewed tokens rather than merging simulated backend state or fake deletion.
- **Rework** #6's SDK typing, evidence/policy and cancellation/budget handling after the local query layer exists. Do not present four disabled/tool-shape tests as proof of an enabled private assistant.
- **Resolve through design/spikes**, rather than arbitrary replacement: encrypted native adapter/keys, authorized filesystem roots, native browser host, safe snapshots/recovery and Windows distribution.

No complete rewrite or deletion of these contributions is recommended. [Each finding](findings.md) names severity, evidence, branch/symbols, owner, correction, risk, effort and whether it was safely fixable now.

## E. Work that can be kept

Keep npm workspaces, strict TypeScript/Zod, bundled private source packages, Forge/Vite builds, isolated renderer, narrow validated preload, strict sender/frame/location checks, production CSP/custom protocol, pure SessionService, parameterized SQL/foreign-key work, repository/strategy fixture seams, inactive permission-free extension and CI foundation. Salvage #4 validation/query work, #5 normalization and #3 visual tokens with their owners. Existing models are useful direction but not proof of implemented storage/recovery.

## F. PR integration recommendations

PRs #1/#2 are already merged; friend-feature is already an ancestor. #3 is not ready and fails packaged CI. #4/#5/#6 currently pass CI but are not safe complete integrations. #5 includes #4; #6 includes both.

Review local stabilization and failure contracts first. Repair bounded #4 work and #3 API-safe UI separately. Integrate #5 only after lifecycle/utility/consent/encryption gates. Review #6 much later, after actual local evidence/tool prerequisites. The [integration plan](pr-integration-plan.md) details overlap, tests, splits/rebases and rollback. No merge/rebase/cherry-pick or remote mutation was executed.

## G. Development roadmap

1. **Stabilization:** RWA-000–003 — review fixes, approve lifecycle modes/semantics, split pending PRs and improve failure verification.
2. **Core safety:** RWA-100–103 — serialized fixture coordinator, encrypted storage/key spike, deterministic repositories and supervised consented utility composition.
3. **Activity/timeline:** RWA-200–202 — measured Windows adapters/health, idle-lock policy and authorized paged timeline.
4. **Capture/recovery:** RWA-300–303 — canonical stable identity, verified encrypted original bytes, engine-owned recovery and honest confirmation UI.
5. **Browser/search/checkpoints:** RWA-400–403 — secure host transport, separately permissioned extraction, local FTS5, referential pins/reopen.
6. **Gemini:** RWA-500–502 — scoped tools, revocable typed SDK adapter and grounded recall evaluation/UI.
7. **Notch:** RWA-600–601 — role/focus/design contract, shared backend clients, then approved overlay/mascot implementation.
8. **Release hardening:** RWA-700–703 — complete retention/key/privacy coverage, signed distribution and full failure/accessibility/performance evidence.

Encryption and revocable permission are prerequisites in step 2, not delayed until release hardening. See the [task-level roadmap](development-roadmap.md) for modules, owners, approaches, dependencies, tests, acceptance, effort and separate-PR recommendations.

## H. Team responsibilities

| Owner               | Next meaningful work                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rasit               | Approve D1/D2 and implement the synthetic serialized coordinator slice; retain final security/integration/merge authority.                                                          |
| Hacer Dilara        | Repair #3 against the current DesktopApi and keep loading/error/disabled states honest; coordinate tokens with Abdullah.                                                            |
| Mohammed Bashli     | Prove encrypted SQLite/FTS/key feasibility and repair migration/query evidence behavior against fixtures; review storage-owned code even where authored by another teammate.        |
| Mohammad Poorhamadi | Review the isolated safety/test commits; specify truthful collector health/stop behavior and measure native strategy compatibility without enabling default monitoring.             |
| Abdullah            | Define clear consent/off/unavailable/evidence/recovery states and review token/accessibility behavior with Hacer; prepare later notch/mascot specs only when its phase is approved. |

## I. Decisions required from Rasit

| Decision                            | Preferred option / reason                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 — runtime modes/storage failure  | Durable mode fails closed; explicit synthetic fixture mode never substitutes after failure. Prevents pretend persistent success.                                                           |
| D2 — lifecycle/partial failure/quit | Serialized candidate/commit transitions, compensation, invalidated generations and drain acknowledgement. Makes pause/end/revoke meaningful.                                               |
| D3 — cipher/native/key/blob stack   | One proven encrypted SQLite/FTS5 plus authenticated blobs and OS-protected key design. Require exact packaged Windows evidence before personal history.                                    |
| D4 — Windows/folder adapters        | Benchmark get-windows/@parcel/watcher against corrected prototypes through injected ports. Choose on actual compatibility/resource evidence.                                               |
| D5 — file identity/recovery/pins    | Engine-owned canonical identities, immutable captured bytes, copy default and verified preservation before overwrite. Scope and target races cannot be delegated to stored strings/models. |
| D6 — browser transport              | Exact-origin Native Messaging with authenticated bounded same-user utility ingress and fresh generations. Avoid an unauthenticated reachable Node server.                                  |
| D7 — cloud model/keys/evidence      | Official SDK types, current model evaluation, OS-protected user credentials, explicit sharing and revocable bounded evidence requests. Local search remains offline.                       |
| D8 — notch/lifetime/release/license | Separate authorized UI roles sharing one backend; explicit focus/monitor/lifetime rules; signed per-user distribution and reconciled MIT/UNLICENSED status.                                |

These are review items, not claims that approval or implementation happened. The audit itself is finished without selecting an unverified cipher, installer or model for production.

## J. Recommended next Codex goal

The most useful next implementation is lifecycle correctness with synthetic ports, before new features. Copy and review this prompt; using it authorizes the stated local implementation policy, not a merge or live recording:

```text
Implement the Rewind audit's focused lifecycle safety slice (RWA-001/RWA-100).
Read AGENTS.md and docs/audit/{findings,architecture-improvement-plan,
pr-integration-plan,validation-report}.md on the audit branch first.
Create a new local feature branch in a separate worktree from
audit/collector-stabilization so the
existing SessionCoordinator is available; preserve both audit branches.

Use synthetic collectors/repositories only. I approve this policy for the slice:
serialize lifecycle commands; publish successful state only at the documented
commit point; check every Result; on failed start invalidate the generation,
stop every partially started collector and report structured failure rather
than successful recording. Preserve the prior public state where possible;
if compensation or durability cannot be established, expose unavailable/error
and keep collection disabled. Define that outcome explicitly before coding.
Pause/end/revoke must invalidate authorization first and acknowledge success
only after sources stop, queued/in-flight work quiesces, and required state
changes are durably acknowledged. An earlier start/resume must never restart
capture after a later stop acknowledgement. Worker restart grants no consent.

Promote the four preserved coordinator probes into regression tests. Add partial
startup/save/stop failure, rejected Promise, concurrent action, revocation,
stale callback and pending append tests using controlled asynchronous fixtures.
Keep the current public DesktopApi compatible; document any necessary contract
change and its downstream consumers. Record approved semantics in an ADR.

Do not enable real monitoring or launch the unmerged recording app. Do not add
Gemini, recovery, UI redesign, a new database/binding, or the utility host yet.
Keep encrypted-storage/consent gates and the separate later host integration.
Run typecheck, lint, formatting and relevant synthetic suites; inspect failures
rather than weakening assertions. Report exact changes, tests and remaining
runtime-integration gates. Do not merge, push, create remote PRs or publish.
```
