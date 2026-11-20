# One-time automatic recording setup

The subsequent [recording-service repair](recording-service-repair.md) addresses large-folder/long-path failures and a foreground-process lookup race. Its repaired executable supersedes the try-out path below; earlier verification results retain their original scope.

19 November 2026. Branch `feature/automatic-recording-setup`, based on `87b5d20`. User-requested follow-up: approve local app/file tracking once, begin immediately, remember approval and add exclusions afterward. No push, remote PR, merge, installation into a personal profile, signing or publication.

## Implemented behavior

- Dashboard/Settings displays one combined permission and actual default file locations. Approval starts the existing session/collectors without per-app setup or manual folder selection.
- File coverage defaults to supported saved files in verified Desktop, Documents and Downloads. This is not every file on every drive. Missing/unsupported locations are reported. Existing type/size/scan/quota/native checks apply; only captured versions can be recovered.
- Encrypted settings remember approval. Normal reopening starts recording; Pause/End stop this session. **Turn off automatic recording** stops capture and disables future automatic starts without deleting existing evidence.
- Settings saves app and full-path file/folder exclusions. They apply to future captures/indexing; history deletion remains separate.
- Fresh/older profiles remain off until new approval. Worker startup stays default-off, interrupted work stays paused and reconnect never silently restores a grant.
- Browser/Gemini setup remains separate. Checkpoints and confirmed recovery are unchanged.

[ADR 0038](../decisions/0038-one-time-local-recording-setup.md) records authorization, bootstrap, persistence, exclusions and lifecycle choices.

## Validation

`npm run check` passed native-lock validation, TypeScript, ESLint, Prettier and **649 tests / 76 files** (325.18 seconds). Automated verification uses marked temporary synthetic profiles, synthetic app observations and generated files only. No personal activity/documents are captured.

The alternate Forge Windows package passed. The complete packaged-app run passed **all 31 tests (3.9 minutes)**, including setup/restart/exclusion/revoke, worker crash/re-enable, Chrome/Edge integration, content search, checkpoints, document previews, copy/overwrite recovery, notch/focus/keyboard, IPC boundaries and lifecycle failures. The final current-ASAR/Windows guard parser harness passed after the last rebuild (one test, 5.67 seconds).

An earlier broad run passed 29/31, with intermittent native topmost inspection and an early closed overwrite window. All seven document/notch/overwrite scenarios then passed together in 51.9 seconds; the final full 31-test run above is green. The overwrite safety assertions and production/native deadlines were preserved.

Final scope review additionally disables remembered approval when a new folder is selected: choosing it alone cannot silently authorize next-launch capture. Existing scope still works on normal reopen. The affected encrypted-runtime suites passed **20 tests** (49.41 seconds), including a new persisted scope-expansion regression. This is one extra case beyond the earlier 649-test full run. Files/storage copy now states when scope changes or maintenance require renewed approval. Final typecheck, lint and formatting passed; the separate Windows package was rebuilt after this policy correction. All **four affected packaged setup/files/storage scenarios passed** against that rebuild (40.0 seconds).

The original output folder was locked by the user's already-open Rewind process, so the standard package command stopped with EPERM. No user process was terminated. The current verification build is produced through Forge's `api.package` with output `apps/desktop/out/automatic-recording`. App/document test harnesses accept `REWIND_TEST_EXECUTABLE` so every asset/installer/parser check targets the same selected build instead of mixing it with the old folder. The original running app is not an automated fixture.

Initial packaged regressions exposed a background screenshot wait in the document case (native focus now precedes capture) and intermittent false topmost inspection during native show/screenshot transitions. The controller defensively reapplies its existing [floating priority](https://www.electronjs.org/docs/latest/api/browser-window#winsetalwaysontopflag-level-relativelevel) after inactive show without activating the window. Tests await actual native visibility/topmost state; sandbox, focus, single-worker and capability assertions remain intact. No production/native resource deadline was extended. The new multi-launch onboarding test waits for its actual setup acknowledgement before inspecting recording state.

Inspected UI evidence: [automatic recording enabled](../design/automatic-recording/enabled.png), and [setup/off after durable opt-out](../design/automatic-recording/setup.png). The 800-pixel-wide layout check passes without horizontal overflow.

The earlier unsigned ZIP/installer and release manifest retain their original source commit and do not contain this change. The subsequently rebuilt desktop verification folder is not a signed or deployment-approved release.

To try the updated build, close any existing Rewind instance and run from the repository root:

```powershell
& '.\apps\desktop\out\automatic-recording\Rewind-win32-x64\Rewind.exe'
```

Review the displayed locations and choose **Allow and start recording**. This normal launch uses the user's profile; automated tests instead pass a marked synthetic temporary profile. Verification can target the separate build by temporarily setting `REWIND_TEST_EXECUTABLE` to its absolute executable path before `npm run test:app` or `npm run test:documents:packaged`, then removing that environment variable. Product changes remain local and uncommitted on the feature branch for review.

## Acceptance limits

Physical Known Folder redirection, OneDrive/offline files and unsupported filesystems require device acceptance. No whole-drive monitoring, every-save guarantee, unsaved-edit recovery or workspace-layout restoration is claimed. Security review, signing/licensing and isolated install/upgrade/removal remain release gates.
