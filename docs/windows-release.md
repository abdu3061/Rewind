# Windows beta candidate: build, acceptance and removal

The current [beta 2 installer](https://github.com/abdu3061/Rewind/releases/tag/v0.1.0-beta.2) replaces the stock setup animation and Electron uninstall icon with Rewind branding. [Installer acceptance](audit/professional-installer.md) records non-silent setup, automatic first launch, normal shortcut launch and a beta 1 to beta 2 installation with retained synthetic encrypted profile/key. Quit Rewind before running an updated Setup; use the installed Rewind shortcut afterward. Interrupted/future upgrade paths and broader signing/device acceptance remain outstanding.

20 November 2026: the owner-authorized [first evaluation beta](https://github.com/abdu3061/Rewind/releases/tag/v0.1.0-beta.1) is published. [Deployment evidence](audit/beta-deployment.md) records full desktop/browser/document checks, hardened production/installer-payload verification, and clean install/uninstall/same-version reinstall on a disposable hosted Windows runner. Signing, newer-version/failed upgrades, physical device/OneDrive acceptance, long-duration profiling, independent review and live Gemini acceptance remain outside this beta's completed scope. The historical candidate procedure below remains the wider-release checklist. Use the optional `beta_installer_only` workflow dispatch input to recheck the exact uploaded beta on an isolated runner; the installation script refuses ordinary local execution.

This is a local unsigned Windows x64 candidate, pending the gates in [release readiness](audit/release-readiness.md). Rasit approves the installer/publisher, license, final source review and distribution. There is no automatic updater or release publication in this workflow.

The subsequent [automatic-recording follow-up](audit/automatic-recording-setup.md) changes local approval under ADR 0038. For upgrade/reinstall acceptance, verify the actual persisted automatic-recording choice and originally approved roots: opted-in local recording may start on normal opening, while opted-out/fresh profiles and browser/cloud grants stay off. Do not silently add newly resolved locations. Older blanket restart-off expectations below apply to manual grants, not an opted-in automatic setup. The earlier archives retain their original build provenance.

The subsequent premium desktop/notch candidate is tracked in its [implementation and validation report](audit/premium-notch-implementation.md). Minimize now shows a restricted floating notch; Open Rewind/taskbar/tray restore the existing full window. Closing the desktop and Quit still acknowledge background shutdown. Automated geometry/focus tests do not replace physical multi-monitor/DPI, tray-shell, fullscreen application and assistive-technology acceptance on the target Windows hardware.

## Reproduce a candidate

Use Windows PowerShell, Node 22.13+ within 22.x and npm 10+. Run from the repository root:

```powershell
npm ci
npm run check
npm run build
npm run test:app
npm run test:browser
npm run test:documents:packaged
npm run make
npm run verify:release
```

Run native suites sequentially: concurrent packaging/install/crypto work can consume Windows Job Object admission deadlines. `test:browser` needs installed Chrome and Edge. Tests use fresh marked temporary synthetic profiles/files and generated test registration names. Never point verification at personal activity/history or real documents.

`build` creates a Playwright-verifiable folder with its main inspector enabled. `make` **rebuilds** with the inspector disabled and then creates both:

- `apps/desktop/out/make/zip/win32/x64/Rewind-win32-x64-0.1.0.zip`
- `apps/desktop/out/make/squirrel.windows/x64/Rewind-Setup.exe`, the full NuGet payload and `RELEASES` metadata.

`verify:release` checks release fuses, resources, exact browser and notice hashes, matching executable/ASAR/inventories/build receipt in ZIP and NuGet, and real hardened startup/graceful window-close shutdown in a synthetic profile. It rejects ordinary inspector-enabled `build` output and artifacts built from a dirty checkout. It writes a SHA-256 `release-manifest.json` beside the artifacts, preserving the source commit, lock hash and dirty state captured **at build time**, rather than attributing an old package to a later checkout. Build from committed source before handing artifacts to anyone. It does not install the app or claim Authenticode trust. Re-run `build` before subsequent Playwright application tests; they need the inspector. Document harness tests use the ordinary development Electron executable and separately verify actual packaged parser assets.

The hardened smoke deliberately opens its synthetic desktop window. A Windows CloseMainWindow check verifies that the close button minimizes Rewind to the notch without stopping it, then `Rewind.exe --quit` exercises the normal acknowledged shutdown (ADR 0042). It creates no recording/cloud grant. Installer acceptance closes the window the same way and falls back to `--quit` for builds that keep running. Its startup/memory snapshot is a short default-off main-process sample, not a whole-app soak benchmark. No authentication dialog is automated.

The application includes original beta artwork/metadata and `resources/notices/inventory.json` plus upstream notice files. Preserve Electron's `LICENSE` and `LICENSES.chromium.html`. Original-source licensing and embedded native/font notice review remain unresolved distribution gates.

## Signing without source credentials

Follow [Forge's Windows signing guidance](https://www.electronforge.io/guides/code-signing/code-signing-windows) and the installed `@electron/windows-sign` API. Supply an **absolute path outside this repository** to a CommonJS module exporting `async function(fileToSign)`. That function signs the given file with the owner's approved certificate-store/token/HSM process, timestamps and verifies it, and rejects on any failure. Never return success for an unsigned file; do not print keys, token PINs or command-line secrets. The Forge adapter cannot independently certify a custom signer.

```powershell
$env:REWIND_WINDOWS_SIGN_MODULE = 'C:\private-build-tools\rewind-signer.cjs'
$env:REWIND_REQUIRE_SIGNING = '1'
npm run make
npm run verify:release
Remove-Item Env:REWIND_WINDOWS_SIGN_MODULE
Remove-Item Env:REWIND_REQUIRE_SIGNING
```

This route is implemented and tested with synthetic byte mutation, not a real certificate. The adapter updates native browser inventory hashes after host signing; do not sign/mutate those bytes later without rebuilding the inventory and repeating payload/runtime checks. Verify the Authenticode chain, publisher and timestamp of Setup, Update, Rewind, native hosts/guard and unpacked native modules using the approved signing tooling. Validate both actual signed installer payloads and installed Chrome/Edge integration. Do not publish until the owner accepts these results. Fuse hardening follows [Electron's documented package-time toggles](https://www.electronjs.org/docs/latest/tutorial/fuses).

## Isolated install, upgrade and uninstall acceptance

Use a disposable supported Windows VM/account with no personal documents/browser profile. Windows Sandbox may be used only if available and persistence/upgrade acceptance is handled separately. Copy artifacts from the exact manifest under test; disable network except explicitly approved synthetic browser fixtures or the separate manual Gemini check.

1. Install unsigned candidate under a synthetic user. Record expected SmartScreen/unsigned status; never bypass enterprise policy. Confirm Apps & features entry, Start Menu/Desktop shortcuts, Rewind icon/metadata, and per-user installation (normally `%LOCALAPPDATA%\Rewind\app-<version>`). Record actual paths and ACLs. No administrator rights, runtime compiler, host registration, recording approval or cloud request should be needed on first launch.
2. Open/close/restart using a fresh synthetic profile: all capture/cloud starts off. For ADR 0038, put generated files only in that isolated profile's default-folder fixtures, review locations and approve automatic local recording once. Verify immediate capture, normal reopen into a new active session, exclusions, Pause/End, durable automatic opt-out and crash/reconnect remaining stopped. Legacy manual grants and browser/cloud launch grants expire. Verify saved versions, Search, copy recovery, checkpoint Keep and encrypted restart. Repeat installed Chrome/Edge flows with explicit desktop setup and extension approval; record extension installation steps, which are not store distribution. Never run default-folder capture against real personal folders as an automated installer test.
3. Preserve the synthetic profile and install a separately versioned **newer** candidate. Verify settings, sessions, kept originals, encrypted key access and migrations. All launch approvals must expire. Versioned install paths change: browser status must fail closed and explicitly offer setup repair; confirm repair against the current executable before fresh approvals. Do not assume an old installation receipt authorizes the new path. Test interrupted upgrade/locked files and a failed native/DPAPI startup without deleting or replacing history. Do not downgrade a migrated database as a rollback strategy.
4. In Settings remove the owned browser connection and remove the Gemini key if configured. Verify both registry views through the normal owned-registration path. If the user wants history removed, explicitly delete it in Settings, choosing whether to include kept evidence. Exported recovery/preservation files remain ordinary independent files.
5. End the session and quit. Uninstall through Windows Apps & features. Verify program/shortcuts are removed and encrypted app data is retained. Installer callbacks manage shortcuts only; they do not silently open keys, delete history or change registry ownership. If browser removal was skipped, a stale owned registration may remain; reinstall and use Settings to remove it safely. Do not recursively delete arbitrary registry keys.
6. Reinstall the same/newer app under the same Windows account; verify retained encrypted history opens and approvals remain off. Profile deletion/key loss/another Windows account can make history unrecoverable. After explicit user authorization, data removal may include the retained Rewind profile; never delete a guessed AppData path or claim forensic erasure. Capture actual uninstall/upgrade/repair results and signatures before release approval.

This VM matrix is a manual gate until actually executed. The automated archive/hardened runtime checks are not installation acceptance. Test certificate failures, offline operation, display scaling, screen readers and a long session separately.

## Diagnostics and support

The normal profile is managed by Electron under the Windows user's AppData Rewind directory; the exact path depends on the installed identity. `logs/operations.jsonl` and one rotated prior file contain only UTC timestamps and fixed operational codes (about 128 KiB total). Native worker/parser streams are drained, not copied into the log. These logs remain after history deletion/uninstall and contain no evidence or keys by design. Logging failure does not prevent encrypted startup/shutdown. Share only these code records and version/manifest by default; do not upload databases, credentials, document bodies, paths, URLs or crash dumps casually.

Startup failure preserves history. Try the same/newer accepted build and investigate missing/tampered resources, key protection or failed migrations. Never work around failure with plaintext/in-memory persistence. A renderer crash requests acknowledged shutdown; reopening requires fresh source approval. A failed shutdown remains a visible error that requires retry. There is no automatic crash upload or telemetry service.
