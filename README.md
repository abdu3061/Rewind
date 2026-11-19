# Rewind

Rewind is a Windows desktop work-session memory project. The local Windows beta candidate provides consent-driven recording, encrypted saved versions, search and reviewed recovery. It is not an approved release. See [release readiness](docs/audit/release-readiness.md), the [Windows build/install/removal procedure](docs/windows-release.md) and the [core implementation report](docs/audit/core-functionality-integration.md).

## What works today

- Electron + React desktop shell with Dashboard, Timeline, Search, Files, Checkpoints, and Settings.
- Persistent Start → Pause → Resume → End controls through a validated preload bridge and supervised utility process. Invalid transitions and failed writes return errors.
- Collection starts off. Explicit Windows activity approval plus an active session records permitted application names, window titles and timestamps. Approval expires on every app/worker restart; application exclusions persist. Known browser windows and Rewind are skipped.
- Timeline and local keyword search read encrypted SQLite/FTS history with session/date/type filters, paging and live updates. Interrupted active sessions recover paused with a capture gap. A title does not prove a saved/read file.
- Search also finds actual retained text/code, DOCX body text and PDF selectable text. Newly captured versions are indexed under active file-capture approval; Search shows progress, pending/unavailable counts, Stop and explicit retained-history indexing/retry, including while capture is paused. Snippets open verified previews and original-byte recovery. Text/FTS stays in encrypted history, follows retention/Keep/deletion and is excluded from Gemini evidence sharing. Extraction is bounded to 64 KiB and 50 PDF pages; unavailable or unindexed text can leave searchable content incomplete. See [ADR 0035](docs/decisions/0035-captured-content-search-integration.md).
- Select local NTFS folders in Files and separately approve file capture for this launch. Active sessions capture bounded initial/saved bytes into encrypted SQLite BLOBs with verified Windows identities and hashes. Versions survive restart. Files and Checkpoints show escaped UTF-8 text, DOCX body text and PDF selectable text through a separately guarded utility, with cancellation and current retained-source verification. Previews are limited to 64 KiB and 50 PDF pages; layout/images/headers/footers and OCR are unavailable. Parser failures leave verified original bytes recoverable. Capture progress, failures and limits are visible; brief intermediate saves can be missed.
- Preview a captured version in Files, choose a new recovery-copy destination, review the source/hash/target and explicitly confirm. The backend rechecks retained bytes and native directory identity, writes only a new file and verifies its complete bytes. Existing destinations are rejected. Exported copies are ordinary files outside Rewind's encrypted-history retention/deletion.
- Optionally overwrite an existing file after a separate native selection and explicit review. Rewind detects changed/locked targets and first flushes and verifies the current bytes as a new preservation file in that folder. An interrupted write can leave an incomplete target; the preservation file remains outside encrypted history and survives history deletion. See [ADR 0024](docs/decisions/0024-confirmed-overwrite-preservation.md).
- Create a named checkpoint from actual same-session file versions and activity. Inspect its evidence, preview/recover selected versions, rename, Keep/Unkeep or confirm deletion. Keep preserves the manifest and selected versions/bytes/activity/search entries through ordinary cleanup and history deletion; it does not restore uncaptured application state.
- Tray status and acknowledged shutdown. Closing the window ends the session and quits. A worker failure disables recording and requires reconnect/fresh approval.
- Chrome/Edge metadata recording through explicit Settings setup, the normal Manifest V3 extension and an authenticated native host. Separate desktop/extension approvals and an active session are required. Website exclusions, pause/resume/end, encrypted timeline/search, restart and disconnect recovery are verified in isolated packaged tests.

- Optional Gemini questions over one to twelve explicitly selected saved observations. Settings separates encrypted key configuration from launch approval; Search shows the exact local sharing review before Send. The utility uses the official SDK with bounded read-only tools, actual source citations, current retention/exclusion checks, cancellation and explicit insufficient-evidence/provider errors. Page text, file contents and full paths are excluded from this feature.

History now has configurable retention, automatic expiration, usage/quota backpressure and confirmed deletion in Settings; see the [core integration report](docs/audit/core-functionality-integration.md) for policy and verification. Kept checkpoint evidence is protected by ordinary cleanup. Quotas include database journals and can temporarily be exceeded during bounded writes/compaction; deletion cannot promise forensic erasure.

Idle/lock detection and article extraction remain unavailable. Gemini's packaged flow is tested with an offline provider and synthetic sealed key; positive interactive native key entry and a live account request still need manual acceptance. Use nonsensitive development sessions only; independent security review, provider-policy review, licensing and distribution remain release gates. ASAR packaging is not data encryption: history and captured original bytes use a keyed native cipher and Windows-protected key instead.

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

Development start and packaging also generate the Windows x64 browser-host executable and extension assets. This requires the Windows Framework64 C# compiler (`Microsoft.NET/Framework64/v4.0.30319/csc.exe`). Generated assets are ignored and packaged under `resources/browser`; building does not register a host or enable browser recording. The installed host will use these precompiled assets, without a runtime host compiler. See [ADR 0021](docs/decisions/0021-browser-assets-and-owned-registration.md).

| Command                                   | Purpose                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`                             | Launch desktop via Electron Forge and Vite                                            |
| `npm run typecheck`                       | Check packages, Electron, renderer, extension, configs, and app tests                 |
| `npm run lint`                            | ESLint including renderer import boundaries and React hooks                           |
| `npm test` / `npm run test:watch`         | Vitest unit/contract tests                                                            |
| `npm run format` / `npm run format:check` | Prettier write/check                                                                  |
| `npm run check`                           | Types, lint, formatting, unit tests                                                   |
| `npm run build`                           | Typecheck, extension build, and packaged desktop folder                               |
| `npm run test:app`                        | Launch/test packaged Windows executable; run build first                              |
| `npm run test:browser`                    | Isolated native-relay tests using installed Chrome and Edge                           |
| `npm run test:documents:packaged`         | Verify private parser utilities against built Windows ASAR/native assets; build first |
| `npm run make`                            | Rebuild hardened Windows ZIP and Squirrel installer candidates; unsigned by default   |
| `npm run verify:release`                  | Verify final fuses, archives, resources and isolated hardened startup/shutdown        |
| `npm run build:extension`                 | Build the browser client into `apps/browser-extension/dist`                           |
| `npm run dev:extension`                   | Rebuild extension on changes; reload it manually in the browser                       |

The Windows x64 executable is `apps/desktop/out/Rewind-win32-x64/Rewind.exe`. ZIPs go under `apps/desktop/out/make/zip/win32/x64/`; the Squirrel candidate is `apps/desktop/out/make/squirrel.windows/x64/Rewind-Setup.exe`. Outputs are ignored by Git. Run app tests after `build`, then `make` and `verify:release`: final artifacts disable the inspector required by Playwright. Installer events never enable monitoring, load history or silently delete app data. Real install/upgrade/removal, signing, licensing and manual Gemini acceptance remain release gates. ARM64 is not verified. See [repository status](docs/repository-status.md) and the release procedure for current scope.

To test browser recording, open **Settings**, select Chrome and/or Edge and explicitly confirm **Set up browser connection**. Use **Open extension folder**, enable Developer mode at `chrome://extensions` or `edge://extensions`, choose **Load unpacked** and select that opened folder. The extension requests tabs, native messaging and storage permissions. In its popup, choose **Allow and connect**; separately choose **Allow browser activity for this launch** in Rewind, then start/resume a session. Approvals expire on app/service/extension restart. Only a random profile tag persists in browser storage. Private browsing and page text are excluded; query strings and fragments are removed. Setup/removal changes only owned per-user registrations after confirmation. Building or opening the app never registers a host automatically. Use nonsensitive test pages. See [browser integration](docs/browser-integration.md) and [ADR 0023](docs/decisions/0023-desktop-browser-composition.md) for evidence and limits.

## Desktop and notch

Minimize the desktop to show the compact **Rewind notch** at the top of its display. Hover or click to expand it. Start/pause/resume the same session, search recorded activity locally, or save a named checkpoint after selecting actual recent evidence. Try “What was I working on?”, “Find thesis”, “Pause my recording”, or “Save a checkpoint”. These are local commands; Gemini questions and sharing reviews remain in Search. Source permissions still require separate launch approval in the full app.

**Open Rewind** restores your existing page and drafts. Restoring from the taskbar, opening from the tray or launching Rewind again does the same. Escape/click-away collapses the notch; **Hide notch** hides it until you use the tray or minimize again. Minimize continues approved operations. Closing the desktop or **Quit Rewind** ends the session and drains background work. The overlay uses normal floating priority and may yield to exclusive fullscreen apps; it does not inspect their titles or contents.

## Optional Gemini questions

In **Settings**, choose **Configure Gemini key**. Enter your own key in the native Windows dialog's Password field; it never enters the renderer. Saving it does not allow cloud use. Choose **Allow cloud questions for this launch** separately. In **Search**, filter local history, select up to twelve observations, write a question and choose **Prepare local sharing review**. Check only the records you want to share, then choose **Send reviewed question to Gemini**. Preparing a review sends nothing. Answers cite the selected recorded observations; titles do not prove file paths, document reading or uncaptured application state.

**Stop Gemini request** cancels publication, and leaving Search cancels an active question. Approval expires on restart; privacy and explicit history maintenance revoke it. Source changes invalidate affected reviews/answers. A separate confirmed Settings action removes the saved key without deleting history. Local history deletion cannot recall data already sent to Google. No key or cloud connection is needed for local search, capture, checkpoints or recovery. See [ADR 0030](docs/decisions/0030-public-reviewed-gemini-questions.md) for the tested boundary and remaining manual acceptance gates.

## Repository map

```text
apps/desktop/          Electron main + sandboxed preload + React renderer (Forge/Vite)
apps/browser-extension/  Default-off Chrome/Edge Manifest V3 client and popup
packages/contracts/   Validated domain models, ports, public desktop API
packages/engine/      Pure session state machine and failure-aware coordinator
packages/storage/     Encrypted SQLite, migrations, repositories and protected-key port
packages/collectors/  Windows foreground helper, lifecycle ports and inactive browser framing
packages/assistant/   Official Gemini SDK over approved observations; utility only
packages/documents/   Bounded DOCX/PDF text extraction; separate guarded utility only
tests/app/            Packaged Electron integration tests
docs/                 Specification, architecture, ownership, backlog, ADRs
.github/              Windows CI, PR template, CODEOWNERS
```

UI → narrow preload API → authorized main-process handler → supervised utility process → engine/storage/Windows collector. Main owns Windows safeStorage and transfers only the protected store's unwrapped key to the worker. Private TypeScript source workspaces are bundled by Vite; the native runtime is explicitly copied and unpacked from ASAR. Automated app tests use a marked temporary profile and synthetic observation source; they never record the user's desktop.

Document previews read verified original bytes in the recording worker, release its coordinator queue, and use a private bounded relay through main to a separate resource-limited utility. That utility receives no paths, keys or credentials. Files/Checkpoints publish text only after current retained-byte/hash checks and reject stale generation/revision receipts. See ADRs 0031–0033.

Captured-content indexing uses that private processor with preview priority. The worker processes one retained source at a time, rechecks current policy/identity/hash before encrypted publication and invalidates removed source results before cleanup commits. Search exposes typed bounded read/control capabilities; it accepts no renderer-supplied body writes or parser paths. See ADRs 0034–0035. Unit files run with one worker to preserve real native-test admission deadlines; this does not serialize production collectors or remove lifecycle concurrency tests.

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
