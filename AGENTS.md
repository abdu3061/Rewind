# Working on Rewind

Rewind is a Windows desktop work-session memory and recovery project for a five-student team. Read [README.md](README.md), [architecture](docs/architecture.md), and [team tasks](docs/team-tasks.md) before substantial changes. The original research documents are preserved as historical planning; the current specification and ADRs govern new work.

## Scope and boundaries

- Use npm workspaces, Electron Forge, Vite, React, and strict TypeScript. Keep code small and readable. Do not introduce Python, a remote database, auth service, cloud storage, ADK, or a dependency framework.
- `apps/desktop/src/main` owns Electron windows, tray, IPC authorization, and composition. `preload` exposes explicit validated capabilities. `renderer` owns presentation and has no Node, database, filesystem, secrets, or collector access.
- `contracts` has no Rewind-package dependencies. Other packages depend on contracts; engine orchestrates ports. Infrastructure must not import the renderer or Electron. Keep Electron utility-process entry points in the desktop composition layer.
- Private workspace packages expose TypeScript source for Vite/Vitest to bundle. Do not run them directly with Node or publish them as built libraries.
- The current session service is synchronous and in memory, hosted in main temporarily. It does not collect, persist, protect files, or call AI. Do not present placeholders as implemented features.
- New background services belong in Node-capable Electron utility processes. Do not move slow file parsing or SQLite into the renderer/main event loop.

## Privacy and safety

- Collection stays off until explicit consent, exclusions, session lifecycle, and engine authorization are enforced. Pause/end must quiesce collectors and reject stale queued events. Never automatically enable monitoring.
- No keystrokes, clipboard capture, screenshots, hidden monitoring, or incognito/private-browser access. Article extraction needs separate site permission. Never execute captured markup.
- Keep context isolation, sandboxing, and web security on; Node integration off. Validate IPC payloads, response shapes, sender identity, main-frame identity, and renderer location. Do not expose raw IPC or a generic filesystem API.
- Default cloud AI to off. No API keys in renderer, `VITE_*`, Git, logs, or extension storage. Future Gemini uses only the official `@google/genai` SDK with minimal approved evidence and bounded validated tools.
- AI can search and propose recovery; it cannot confirm/execute recovery. Save copies by default. Before an explicit overwrite, successfully preserve and verify current contents; abort on any failure or concurrent change.
- Encryption-enabled SQLite, encrypted snapshots, OS-protected keys, integrity hashes, retention, deletion, and quotas are release gates. Stock SQLite and ASAR are not encryption. Never silently fall back to plaintext persistence.
- A path marked verified in a record is not an authorization token. Validate canonical paths, roots, reparse points, size, identity, destination, and race conditions in the engine at the time of use.
- Log structured codes and operational context, not document text, window titles, full URLs, paths, or keys by default.

## Ownership and approval

Rasit (`@RXD3`) owns architecture, session/snapshot/recovery/checkpoint engines, AI, privacy authorization, integration, final tests, dependencies, and final merge/release approval. Hacer Dilara owns React and preload integration; Mohammed Bashli owns schema/repositories/FTS/retention queries; Mohammad Poorhamadi owns collectors/extension/transport; Abdullah owns UX/Figma/tokens/specs and UI review. See [team ownership](docs/team-ownership.md) for handoffs.

Architecture, shared contracts, dependencies, security, and recovery changes require Rasit's review. Explain substantial choices and record an ADR. Proposed native-host and encryption choices are not approved implementations. Work on a feature branch; use PRs into stable `main`. Do not publish, push, merge, or create remote PRs without explicit user authorization. Do not invent teammate GitHub usernames.

## Commands and verification

Use Windows PowerShell, Node 22.13+ within the 22.x line, npm 10+. Run from the repository root:

```powershell
npm ci
npm run dev
npm run typecheck
npm run lint
npm test
npm run format:check
npm run build
npm run test:app
```

`npm run build` builds the extension and packages the desktop folder; `npm run make` creates a Windows ZIP, not an installer. `test:app` requires the built Windows executable. No Playwright browser download is necessary for Electron tests.

Add meaningful tests for lifecycle, security boundaries, persistence, migrations, collector shutdown, and recovery failures as those modules arrive. Test public behavior and failure paths, not private implementation details. Update contracts and docs together. Run affected checks, fix failures, and report actual results. Do not claim installer, native integration, encryption, or Chrome/Edge end-to-end verification unless tested. Preserve user work and existing Git configuration.
