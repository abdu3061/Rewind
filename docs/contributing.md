# Contributing

Use Node 22.13+ in the 22.x line, npm 10+, Windows PowerShell, and the root workspace commands in [README](../README.md). `npm ci` installs the committed lockfile. `npm run dev` starts Electron Forge. VS Code is recommended; no particular extensions or machine-wide policy changes are required.

## Branches and pull requests

`main` is the stable integration branch. Substantial work happens on feature branches such as `feature/session-engine`, `feature/database-schema`, `feature/timeline-ui`, and `feature/browser-collector`. Keep changes small enough to review and connect each PR to a task ID from [team tasks](team-tasks.md).

After the owner's initial repository bootstrap, never commit directly to `main`. This local initialization is on `feature/project-initialization` and makes no commit, push, or remote PR. The repository originally had an unborn `main` and an existing origin; the owner must decide/authorize the first baseline before normal PR development. Do not assume remote history is empty or force-push over it. Inspect/fetch under the owner's workflow before connecting histories.

When a baseline exists, a normal local workflow is:

```powershell
git switch main
git pull --ff-only
git switch -c feature/session-engine
npm ci
# Make a small change and run the relevant checks.
npm run check
npm run build
npm run test:app
git add <specific-reviewed-files>
git commit -m "feat(engine): add consent-gated session coordination"
```

Publishing the branch and opening a PR are separate owner-authorized steps. Future Codex sessions must not push/create remote PRs without user permission. Never commit keys, actual activity history, snapshots, local databases, dependency directories, or build output.

PR descriptions explain the concrete behavior change, implementation/boundaries, validation commands/results, and unresolved limitations. Use the template. Include screenshots for UI changes, synthetic data where needed, and failure-path evidence for collector/storage/recovery changes. Resolve review comments; rerun checks when code changes. Merge only with Rasit's final approval and passing required checks.

Use descriptive commits, preferably `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, or `docs(scope): ...`. Do not put unrelated refactors into a feature PR. Contract/architecture/dependency/security/recovery changes need Rasit's review before dependent implementation. Module owners also review their areas; Abdullah/Hacer review user flows together.

## Manual GitHub configuration required

The repository owner must configure rulesets/branch protection and collaborator roles in GitHub. No remote settings were changed here. As a target configuration:

- Require PRs for `main`, required checks from `CI / windows-checks`, up-to-date branch checks, resolved conversations, and code-owner review.
- Assign the actual required check name after the first authorized CI run; GitHub may display the job name `windows-checks`.
- Restrict protected-branch updates/merges to Rasit (`@RXD3`) using the repository's available rules/permissions. Give others feature-branch collaboration rights without bypass rights. Disable force pushes/deletion and unreviewed bypasses.
- Require a fresh review after material changes. Use least-privilege repository roles and an owner-controlled merge process. Check the actual plan's ruleset features and test restrictions with a teammate account.
- `CODEOWNERS` currently names only `@RXD3`; add real teammate usernames later. It requests reviews and can support a required-review rule, but **alone it enforces neither approval nor exclusive merge authority**.

An owner-authored PR may need a second authorized reviewer because GitHub does not count self-approval. Decide that policy explicitly; do not fake approval or weaken the documented security review. Branch restrictions and review rules must be configured and tested together. [GitHub protected branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)

## Code and tests

Use strict TypeScript, explicit domain types and bounded runtime schemas at trust boundaries. Avoid `any`, circular dependencies, giant files, framework-heavy abstraction, and silent success stubs. Render captured content as text. Keep privileged operations out of React. Follow Prettier and ESLint; run `npm run format` before review.

Unit tests must cover meaningful valid/invalid lifecycle and security behavior. Persistent implementations need migrations/transaction/integrity tests; collectors need consent/pause/end/stale-generation tests; recovery needs failure and interruption tests. Tests should describe externally visible guarantees. Test-only synthetic adapters are welcome behind ports; no production fallback may pretend encryption, protection, or history works.

`npm run check` covers types, lint, formatting, and unit tests. `npm run build` verifies extension assets and a Forge package; `npm run test:app` verifies that packaged executable in Windows. `npm run make` makes an unsigned ZIP, not an installer. Native-module or Forge/Vite upgrades require fresh package-and-launch checks. CI is configured for Windows with read-only repository permissions and no release/publish step. Report checks actually run and known platform limits.
