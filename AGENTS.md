# Working on Rewind

Rewind is a Windows desktop work-session memory and recovery project for a five-student team. Read [README.md](README.md), [architecture](docs/architecture.md), and [team tasks](docs/team-tasks.md) before substantial changes. The original research documents are preserved as historical planning; the current specification and ADRs govern new work.

## Scope and boundaries

- Use npm workspaces, Electron Forge, Vite, React, and strict TypeScript. Keep code small and readable. Do not introduce Python, a remote database, auth service, cloud storage, ADK, or a dependency framework.
- `apps/desktop/src/main` owns Electron windows, tray, IPC authorization, and composition. `preload` exposes explicit validated capabilities. `renderer` owns presentation and has no Node, database, filesystem, secrets, or collector access.
- `contracts` has no Rewind-package dependencies. Other packages depend on contracts; engine orchestrates ports. Infrastructure must not import the renderer or Electron. Keep Electron utility-process entry points in the desktop composition layer.
- Private workspace packages expose TypeScript source for Vite/Vitest to bundle. Do not run them directly with Node or publish them as built libraries.
- The desktop supervises a utility process containing the session coordinator, encrypted SQLite and consent-gated Windows/selected-folder collectors. Both approvals expire on app/worker restart and require an active session. Folder selection uses a native dialog; every read revalidates real Windows identities, roots, reparse points, size and sharing. Capture publishes original bytes/metadata/evidence atomically; UTF-8 previews are escaped. Confirmed recovery copies reverify retained bytes and native destination proof, create only a new file and verify the result. Named checkpoints pin actual same-session versions and activity, with verified views, rename/Keep and confirmed removal. See ADRs 0010–0015 and the core integration report. Chrome/Edge metadata collection uses separate launch-scoped desktop and extension approval, authenticated native peers, explicit owned setup and current engine authorization (ADRs 0016-0023). Optional overwrite uses a separate expiring confirmation, current identity/hash/write-time proof, exclusive handle/oplock and a fully flushed verified ordinary preservation file before mutation (ADR 0024). Failure can require recovery from that preserved file; it is outside encrypted-history retention/deletion. Idle/lock and article extraction remain unavailable. Optional Gemini uses native sealed key entry, separate launch approval and immutable per-question reviews over selected retained observations (ADRs 0025-0030). It shares no file contents/full paths or page text and has no destructive tools; interactive native-entry/live-account acceptance remains manual. Automated app tests must use marked temporary synthetic profiles and files; never capture actual personal activity in tests.
- Encrypted history has configurable retention, automatic expiration, physical usage/quota backpressure and confirmed deletion; see ADR 0012 and the core integration report. Explicit storage maintenance stops/drains sources and revokes launch approval. Kept evidence survives ordinary cleanup/deletion. Session date/status shells and privacy settings remain; never claim forensic erasure or a filesystem hard quota.
- New background services belong in Node-capable Electron utility processes. Do not move slow file parsing or SQLite into the renderer/main event loop.
- DOCX/PDF previews use a separate single-use utility after verified original-byte reads. Preserve Windows Job Object admission, deadlines, actual-exit confirmation, private bounded binary transport, request-specific cancellation and post-parse retained-byte verification (ADRs 0031–0033). Preview generation/revision receipts fence stale UI content. Automatic cleanup invalidates affected sources before commit; explicit maintenance confirms parser drain. Render only escaped text, and keep document bodies out of the metadata-only Gemini flow. The Node utility is not an OS filesystem/network sandbox.
- Captured body search uses bounded encrypted derived text/FTS tied to retained original versions (ADRs 0034–0035). Automatic indexing requires the current active session and file grant; explicit retained-history backfill does not grant monitoring/cloud access. Preserve current exclusions, source/hash/quota rechecks, Keep/cascade lifetime, source-specific search invalidation, owner-scoped parser stop and outside-coordinator settlement before storage closes. Search results stay escaped and excluded from Gemini evidence. Unavailable extraction must not prevent original-byte recovery.

## Privacy and safety

- Collection stays off until explicit consent, exclusions, session lifecycle, and engine authorization are enforced. Pause/end must quiesce collectors and reject stale queued events. Never automatically enable monitoring.
- No keystrokes, clipboard capture, screenshots, hidden monitoring, or incognito/private-browser access. Article extraction needs separate site permission. Never execute captured markup.
- Keep context isolation, sandboxing, and web security on; Node integration off. Validate IPC payloads, response shapes, sender identity, main-frame identity, and renderer location. Do not expose raw IPC or a generic filesystem API.
- Default cloud AI to off. No API keys in renderer, `VITE_*`, Git, logs, or extension storage. Gemini uses only the official `@google/genai` SDK with minimal explicitly approved evidence, bounded read-only tools, actual source citations and current source/policy/retention verification. Stale generation/revision replies and expired reviews/answers must be rejected; pending work remains tracked until observed settlement.
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

`npm run build` builds the extension and packages a desktop verification folder with the main inspector enabled for Playwright; `test:app` requires it. Root `npm run make` rebuilds with the inspector disabled and creates Windows ZIP and Squirrel installer candidates. Run `npm run verify:release` afterward; rebuild before subsequent app tests. Installer/signing/upgrade acceptance remains a separate gate in `docs/windows-release.md`. No Playwright browser download is necessary for Electron tests.

Add meaningful tests for lifecycle, security boundaries, persistence, migrations, collector shutdown, and recovery failures as those modules arrive. Test public behavior and failure paths, not private implementation details. Update contracts and docs together. Run affected checks, fix failures, and report actual results. Do not claim installer, native integration, encryption, or Chrome/Edge end-to-end verification unless tested. Preserve user work and existing Git configuration.
