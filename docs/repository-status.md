# Repository status

Current local implementation, 19 November 2026: [core functionality integration](audit/core-functionality-integration.md) on `feature/core-functionality`. Encrypted retention/snapshots, guarded copies/overwrite/checkpoints, normal Chrome/Edge recording and reviewed-evidence Gemini Settings/Search pass the full 478-test check, Windows build, 18 packaged tests and 6 installed-browser tests. DOCX/PDF content previews remain active core work; live-account and interactive native-entry acceptance remain manual gates. The implementation goal is not marked complete.

A fresh fetch finds `origin/main` at `0354ec1`, which merges the earlier PR #6 prototype stack. Its automatic-consent and stock-SQLite/in-memory-success fallback composition conflicts with this verified branch's requirements. Local `main` remains `0391630`, and remote main is not an ancestor of the feature branch. No merge, rebase, push, PR, release or branch deletion was performed. Preserve the feature branch and teammate refs pending explicit owner-reviewed integration. Earlier branch/PR/CI states below are historical snapshots.

This is the earlier cleanup snapshot. The [full engineering audit](audit/README.md) extends it with PR #6, reproduced failure cases, isolated stabilization and a dependency-ordered roadmap. Audit fixes have not been merged into shared main.

Reviewed on 16 November 2026 on Windows x64 with Node 22.16.0 and npm 11.7.0.

## Baseline and branches

Fetched `origin` with pruning. Shared `main` is at `0391630`; the local checkout was already at that commit. Local `main` now tracks `origin/main`. Cleanup work is on `feature/repository-cleanup`, based on that baseline.

`feature/database-schema` (PR #1), `feature/frontend-ui` (PR #2), and `friend-feature` are already ancestors of `origin/main`. Their changes need no additional merge. Branch refs and existing local work were preserved.

No pending branch met the current acceptance criteria, so no additional branch was merged. No push, remote PR creation, remote branch deletion, or repository-settings change was performed.

| Pending branch / PR                                                                           | Latest remote CI | Review outcome                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`feature/design-tokens-privacy`, #3](https://github.com/abdu3061/Rewind/pull/3) at `ba16ceb` | Failed, run 37   | Session UI changes local state before any engine result, subscribes to `onStateChange` instead of `onChanged`, calls `stop` instead of `end`, and does not hydrate initial session state. Monitoring defaults visually to active; retention/cloud/deletion controls simulate behavior. History is synthetic and ordinary-use inline styles conflict with production CSP. Keep open for frontend/UX revision.                              |
| [`feature/sqlite-persistence`, #4](https://github.com/abdu3061/Rewind/pull/4) at `5824ea1`    | Passed, run 38   | Useful repository prototype, but not approved encrypted persistence. Default migration discovery can return no path while `open()` still reports success without tables; a failed open leaves the database handle allocated. Require deterministic migration resources, failed-open cleanup/failure tests, and shared-contract documentation/review. Real history remains gated on ADR 0005 and packaged encryption evidence.             |
| [`feature/data-collectors`, #5](https://github.com/abdu3061/Rewind/pull/5) at `6114324`       | Passed, run 45   | Includes the storage branch. Main hardcodes `collectionConsent: true`, opens plaintext `rewind.sqlite` in userData, and runs collectors/storage in main rather than a utility process. Storage failures silently become successful in-memory repositories. Startup logging includes full paths and raw errors. Keep open until explicit consent, encrypted storage, process boundaries, failure behavior, and safe shutdown are enforced. |

Remote CI results were read from GitHub. This review used the fetched code; the collector branch was not launched locally, so this work did not enable monitoring. PR checkboxes alone were not treated as review evidence.

## Cleanup performed

- Removed unused root `api`, `electron`, `public`, and `src` scaffold files. The runnable workspace entry points remain under `apps/desktop`; historical versions remain in Git.
- Removed the unused duplicate `.prettierrc.json`; `.prettierrc` remains the active formatting configuration.
- Fixed the unconditional Timeline empty state, removed stray Search markup and synthetic activity/checkpoint screens, and removed their unused styles. Unavailable actions are disabled; live session controls still use the validated preload bridge.
- Excluded local `artifacts/` and the pre-existing nested `Rewind/` checkout from Git, ESLint, and Prettier. Both directories and the existing local Git exclusions were preserved.
- Patched Electron from 44.9.0 to 44.11.3 and updated the lockfile. See [ADR 0007](decisions/0007-maintenance-baseline.md) for the dependency decision and review status.
- Corrected documentation that still described an unborn main branch, no CI runs, or no storage prototype.

## Verification

| Check              | Result                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`           | Passed with the patched committed dependency selection; audit findings below.                                                                                                                                                                  |
| `npm run check`    | Passed: TypeScript, ESLint, Prettier, and 49 unit/contract tests across 10 files.                                                                                                                                                              |
| `npm run build`    | Passed: inactive extension build and Forge Windows x64 packaged folder, with Electron 44.11.3.                                                                                                                                                 |
| `npm run test:app` | Passed: 2 packaged Windows tests. Covers session lifecycle, actual bridge state, subscription updates, hydration after reload, navigation/unavailable controls, sandbox/Node isolation, payload validation, and unauthorized-window rejection. |
| Screenshot review  | Reviewed `test-results/dashboard.png`; the Dashboard no longer includes the Timeline empty state.                                                                                                                                              |

The initial check exposed generated presentation code being linted and the nested checkout's historical documents being formatted. Those directories are now excluded without changing their contents. The first expanded app test used an ambiguous Search button locator; it was scoped to the main content and both tests passed on rerun.

The explicit `npm audit` after the Electron patch reported **11 moderate, 0 high, and 0 critical** findings. Moderate findings remain in ESLint/typescript-eslint and Forge/ASAR glob/minimatch dependency chains. The install summary reported a different count; use the explicit full audit for this record. No forced audit fix, major-version migration, or dependency override was applied. Review compatible tooling fixes separately with package-and-launch verification.

No installer, native browser integration, encryption, collectors, actual history persistence, snapshots/recovery, or release was verified. The packaged desktop still provides in-memory sessions only. The older [initialization validation](validation.md) is historical evidence.

## Starting the next feature

Run `npm run dev` from the repository root. Begin new feature work from the reviewed cleanup commit; do not base it on the pending UI/collector integrations.

RWD-100 (utility-process host and consent/generation lifecycle) is the next core integration task. RWD-003 (encrypted storage feasibility) and RWD-004 (Windows/browser capabilities) can proceed using synthetic fixtures and explicit opt-in harnesses. Keep collection off in the desktop until their gates are satisfied. See [team tasks](team-tasks.md) for owners and acceptance criteria.
