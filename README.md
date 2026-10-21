# Rewind

Rewind is a Windows desktop application that will help users remember their work sessions and recover successfully captured saved file versions. Version one targets Windows, Chrome, and Edge. This repository is the **initial runnable foundation**, not the complete product.

## What works today

- Electron + React desktop shell with Dashboard, Timeline, Search, Checkpoints, and Settings.
- Real in-memory Start → Pause → Resume → End session controls through a typed, validated preload bridge. Invalid transitions return structured errors.
- Tray session controls and status. Collection is always off. Closing the window quits the starter; session state resets on exit.
- Strict shared contracts, unit tests, an inactive Manifest V3 extension build, Windows packaging configuration, and packaged-app integration tests.

No activity is collected. No folders are protected. SQLite, file versions/recovery, checkpoints, search, editable settings, encryption, retention cleanup, utility-process services, native browser transport, and Gemini are **not implemented**. Other screens show honest empty states. ASAR packaging is not data encryption.

## Windows / PowerShell setup

Install Git and **Node.js 22.x (at least 22.13)** with npm 10+. Open the repository in VS Code and a PowerShell terminal:

```powershell
node --version
npm --version
npm install
npm run dev
```

Use `npm ci` on subsequent clean checkouts to install the committed lockfile exactly. Run commands from this directory, where the root `package.json` lives. No `.env` file, API key, SQLite runtime, Python, or separately installed browser is required. Dependencies download Electron on the first install; allow network access for that download. No native collectors or SQLite binding are installed yet.

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

The Windows x64 executable is `apps/desktop/out/Rewind-win32-x64/Rewind.exe`. ZIPs go under `apps/desktop/out/make/zip/win32/x64/`. These outputs are ignored by Git. ARM64 is not yet verified. The Windows CI workflow runs the same checks plus packaged application tests; its first remote run will occur only after the owner authorizes a push.

To inspect the inactive extension, enable Developer mode at `chrome://extensions` or `edge://extensions`, choose **Load unpacked**, and select `apps/browser-extension/dist`. It requests no browser/page/native permissions and excludes incognito. The popup explains the missing functionality. No native-host registration is performed. See [browser integration](docs/browser-integration.md) for the proposed shipping design.

## Repository map

```text
apps/desktop/          Electron main + sandboxed preload + React renderer (Forge/Vite)
apps/browser-extension/  Inactive Chrome/Edge Manifest V3 starter
packages/contracts/   Validated domain models, ports, public desktop API
packages/engine/      Tested in-memory session state machine
packages/storage/     Storage adapter boundary; no persistence
packages/collectors/  Collector lifecycle boundary; no monitoring
packages/assistant/   Validated-tool design boundary; no cloud requests
tests/app/            Packaged Electron integration tests
docs/                 Specification, architecture, ownership, backlog, ADRs
.github/              Windows CI, PR template, CODEOWNERS
```

UI → narrow preload API → authorized main-process handler → engine. Future background implementations use Electron utility processes, consume shared contracts, and remain testable without React. The private source workspaces are bundled by Vite; `tsc` checks them without emitting independent packages. Desktop runtime code is bundled, so its source/build dependencies are intentionally development dependencies.

## Team

| Member              | Primary responsibility                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| Rasit (`@RXD3`)     | Owner, technical lead, core engine, AI, recovery safety, integration, final approval |
| Hacer Dilara        | React frontend and approved preload integration                                      |
| Mohammed Bashli     | SQLite schema, repositories, FTS5, retention/storage queries                         |
| Mohammad Poorhamadi | Windows/folder collectors, Chrome/Edge extension and native transport                |
| Abdullah            | UX/Figma, navigation, tokens/components, privacy and recovery flows                  |

Start with [team tasks](docs/team-tasks.md) and [development plan](docs/development-plan.md). All substantial work uses feature branches and reviewed PRs. Rasit controls final merges. `CODEOWNERS` alone does not enforce this: the owner must configure repository rules and collaborator permissions as described in [contributing](docs/contributing.md).

## Project references

- [Version-one specification](docs/project-spec.md), [architecture](docs/architecture.md), [contracts](docs/contracts.md)
- [Security and privacy](docs/security-privacy.md), [ownership](docs/team-ownership.md), [contributing](docs/contributing.md)
- [Architecture decisions](docs/decisions/README.md), [dependencies and licenses](docs/dependencies-licenses.md)
- [Initialization validation](docs/validation.md)

The existing [project plan](docs/project-plan.md) and [technical research](docs/technical-research.md) are preserved unchanged. They describe proposals and future behavior, not the current implementation. The new specification, feature status, and ADRs clarify the initialization boundary.

No third-party project source was copied. Rewind's own distribution license has not been selected; package metadata is `UNLICENSED` and private until Rasit decides. Third-party dependencies retain their own licenses.
