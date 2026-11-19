# Recording service repair

19 November 2026; local uncommitted changes on `feature/automatic-recording-setup`.

The user reported the generic collector capture-gap error immediately after automatic setup. The real profile's fixed-code operational log confirmed repeated service failures; it contains no collector identifier or cause. No personal activity, saved documents or encrypted history was inspected. The running user application was preserved.

Two reproduced causes are repaired: large/default-folder scans and unsupported long entries no longer stop all recording, and an application closing during foreground-process lookup no longer kills its helper. Partial scans continue in bounded pages with native identity checks; skipped entries remain visible. Genuine source failures remain fatal and now identify the affected source. See [ADR 0039](../decisions/0039-bounded-folder-scan-continuation.md).

Verification completed:

- `npm run check`: native-lock check, typecheck, lint, formatting and **654 tests / 76 files passed** (217.03 s for tests).
- Separate Electron Forge Windows verification package: passed, including production main/worker/preload/renderer bundles and native assets.
- Packaged automatic recording, file protection and session tests: **10 passed** (55.2 s), including large-folder/long-entry continuation, original-byte capture, clean reopen, exclusions/revoke, worker crash/reconnect and preload authorization.
- Final changed-document formatting and `git diff --check`: passed.

The repaired verification package uses `apps/desktop/out/recording-repair/Rewind-win32-x64/Rewind.exe`; the already-running automatic-recording executable was not overwritten or terminated. No verification-app processes remained after the tests. No installer, signing, remote integration or real personal-folder capture was performed. The original incident's specific source remains unconfirmed; if a different failure persists, the new fixed source-specific message distinguishes it.

Close the old app and launch the repaired executable from the repository root:

```powershell
& '.\apps\desktop\out\recording-repair\Rewind-win32-x64\Rewind.exe'
```
