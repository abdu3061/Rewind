# Rewind

Rewind is a Windows desktop work-session memory project. This local development branch provides consent-driven activity recording, encrypted history and protected-folder saved versions; it is not the complete version-one product or a release. See the [current implementation report](docs/audit/core-functionality-integration.md).

## What works today

- Electron + React desktop shell with Dashboard, Timeline, Search, Files, Checkpoints, and Settings.
- Persistent Start → Pause → Resume → End controls through a validated preload bridge and supervised utility process. Invalid transitions and failed writes return errors.
- Collection starts off. Explicit Windows activity approval plus an active session records permitted application names, window titles and timestamps. Approval expires on every app/worker restart; application exclusions persist. Known browser windows and Rewind are skipped.
- Timeline and local keyword search read encrypted SQLite/FTS history with session/date/type filters, paging and live updates. Interrupted active sessions recover paused with a capture gap. A title does not prove a saved/read file.
- Select local NTFS folders in Files and separately approve file capture for this launch. Active sessions capture bounded initial/saved bytes into encrypted SQLite BLOBs with verified Windows identities and hashes. Versions survive restart; UTF-8 previews are escaped. DOCX/PDF original bytes are preserved, with document rendering still unavailable. Capture progress, failures and limits are visible; brief intermediate saves can be missed.
- Tray status and acknowledged shutdown. Closing the window ends the session and quits. A worker failure disables recording and requires reconnect/fresh approval.
- Strict shared contracts, unit tests, an inactive Manifest V3 extension build, Windows packaging configuration, and packaged-app integration tests.

History now has configurable retention, automatic expiration, usage/quota backpressure and confirmed deletion in Settings; see the [core integration report](docs/audit/core-functionality-integration.md) for policy and verification. Kept checkpoint evidence is protected by cleanup, although checkpoint creation UI remains forthcoming. Quotas include database journals and can temporarily be exceeded during bounded writes/compaction; deletion cannot promise forensic erasure.

Browser visits, recovery execution, checkpoint creation, idle/lock detection and Gemini remain unavailable. Use nonsensitive development sessions only; independent security review, licensing and distribution remain release gates. ASAR packaging is not data encryption: history and captured original bytes use a keyed native cipher and Windows-protected key instead.

## Windows / PowerShell setup

Install Git and **Node.js 22.x (at least 22.13)** with npm 10+. Open the repository in VS Code and a PowerShell terminal:

```powershell
node --version
npm --version
npm ci
npm run dev
```

Use `npm ci` on subsequent clean checkouts to install the lockfile exactly. Run commands from this directory. No `.env`, API key, Python or separately installed browser is required. Dependencies provide Electron and the pinned Windows x64 Node-API encrypted SQLite prebuild. Windows key protection must be available; failures show an unavailable service without a plaintext or memory fallback. ARM64 and non-Windows recording are not verified.

After deliberately changing dependencies with `npm install`, run `npm run lock:prepare` to preserve the native package's upstream prebuild-only metadata in the lockfile. `npm run check` verifies it; see ADR 0010 for the reproduced npm clean-install issue. Do not replace the prebuild with a local source build without a separate compatibility review.

If PowerShell blocks the `npm.ps1` shim, use `npm.cmd` in the same commands; changing the machine execution policy is unnecessary. A main/preload edit requires restarting `npm run dev`; renderer edits use Vite HMR. Close Rewind or press Ctrl+C to stop development. The dev server binds only to loopback.

| Command                                   | Purpose                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                             | Launch desktop via Electron Forge and Vite                            |
| `npm run typecheck`                       | Check packages, Electron, renderer, extension, configs, and app tests |
| `npm run lint`                            | ESLint including renderer import boundaries and React hooks           |
| `npm test` / `npm run test:watch`         | Vitest unit/contract tests                                            |
| `npm run format` / `npm run format:check` | Prettier write/check                                                  |
| `npm run check`                           | Types, lint, formatting, unit tests                                   |
| `npm run build`                           | Typecheck, extension build, and packaged desktop folder               |
| `npm run test:app`                        | Launch/test packaged Windows executable; run build first              |
| `npm run make`                            | Build a Windows ZIP through Forge; no signed installer                |
| `npm run build:extension`                 | Build inactive extension into `apps/browser-extension/dist`           |
| `npm run dev:extension`                   | Rebuild extension on changes; reload it manually in the browser       |

The Windows x64 executable is `apps/desktop/out/Rewind-win32-x64/Rewind.exe`. ZIPs go under `apps/desktop/out/make/zip/win32/x64/`. These outputs are ignored by Git. ARM64 is not yet verified. The Windows CI workflow runs the same checks plus packaged application tests. See [repository status](docs/repository-status.md) for the latest branch review and local verification.

To inspect the inactive extension, enable Developer mode at `chrome://extensions` or `edge://extensions`, choose **Load unpacked**, and select `apps/browser-extension/dist`. It requests no browser/page/native permissions and excludes incognito. The popup explains the missing functionality. No native-host registration is performed. See [browser integration](docs/browser-integration.md) for the proposed shipping design.

## Repository map

```text
apps/desktop/          Electron main + sandboxed preload + React renderer (Forge/Vite)
apps/browser-extension/  Inactive Chrome/Edge Manifest V3 starter
packages/contracts/   Validated domain models, ports, public desktop API
packages/engine/      Pure session state machine and failure-aware coordinator
packages/storage/     Encrypted SQLite, migrations, repositories and protected-key port
packages/collectors/  Windows foreground helper, lifecycle ports and inactive browser framing
packages/assistant/   Validated-tool design boundary; no cloud requests
tests/app/            Packaged Electron integration tests
docs/                 Specification, architecture, ownership, backlog, ADRs
.github/              Windows CI, PR template, CODEOWNERS
```

UI → narrow preload API → authorized main-process handler → supervised utility process → engine/storage/Windows collector. Main owns Windows safeStorage and transfers only the protected store's unwrapped key to the worker. Private TypeScript source workspaces are bundled by Vite; the native runtime is explicitly copied and unpacked from ASAR. Automated app tests use a marked temporary profile and synthetic observation source; they never record the user's desktop.

## Team

| Member              | Primary responsibility                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| Rasit (`@RXD3`)     | Owner, technical lead, core engine, AI, recovery safety, integration, final approval |
| Hacer Dilara        | React frontend and approved preload integration                                      |
| Mohammed Bashli     | SQLite schema, repositories, FTS5, retention/storage queries                         |
| Mohammad Poorhamadi | Windows/folder collectors, Chrome/Edge extension and native transport                |
| Abdullah            | UX/Figma, navigation, tokens/components, privacy and recovery flows                  |

Start with [repository status](docs/repository-status.md), [team tasks](docs/team-tasks.md), and [development plan](docs/development-plan.md). All substantial work uses feature branches and reviewed PRs. Rasit controls final merges. `CODEOWNERS` alone does not enforce this: the owner must configure repository rules and collaborator permissions as described in [contributing](docs/contributing.md).

## Project references

- [Full engineering audit and roadmap](docs/audit/README.md) — current branch review, verified stabilization, remaining gates and owned future tasks
- [Version-one specification](docs/project-spec.md), [architecture](docs/architecture.md), [contracts](docs/contracts.md)
- [Security and privacy](docs/security-privacy.md), [ownership](docs/team-ownership.md), [contributing](docs/contributing.md)
- [Architecture decisions](docs/decisions/README.md), [dependencies and licenses](docs/dependencies-licenses.md)
- [Initialization validation](docs/validation.md)

The existing [project plan](docs/project-plan.md) and [technical research](docs/technical-research.md) are preserved unchanged. They describe proposals and future behavior, not the current implementation. The new specification, feature status, and ADRs clarify the initialization boundary.

The repository includes an MIT `LICENSE` file, while private packages declare `UNLICENSED` and existing planning documents treat licensing as undecided. Rasit must reconcile the license and metadata before distribution. The audit does not choose or change the project license. Third-party dependencies retain their own licenses.
