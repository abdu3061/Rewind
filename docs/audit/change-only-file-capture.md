# Change-only file capture and performance

19 November 2026; local uncommitted changes on `feature/automatic-recording-setup`.

The user requested copies only for files created or changed while recording, with improved performance. Startup/Resume file imports and periodic unchanged-content reads are removed. The existing native helper now drains bounded, coalesced Windows change notifications, with current root/read/consent authorization. Content-hash checks suppress identical versions across runs; queues, body work and retries are bounded. See [ADR 0041](../decisions/0041-change-only-file-capture.md).

Native tests passed with 2,500 untouched files and no initial change events; collector tests assert zero idle enumeration/body reads, bounded batches/retries, no retention refresh, current authority and duplicate suppression after restart. Encrypted runtime tests passed for actual active-session writes, pause/revoke and restart without importing stopped changes.

The final rebuilt package's successful performance/restart test used **2,501 pre-existing files**. It observed **zero stored versions while idle**, **0.355% average recording-engine CPU** over five one-second samples, and **4,388 KiB working-set growth** across that short measurement. The engine working set ranged from 86,064 to 90,452 KiB. These figures exclude the external PowerShell helper and other Electron processes; they are a short synthetic component measurement, not a universal system benchmark. [Raw measurements](change-only-performance.json) are retained without profile paths or process identifiers.

The same test confirms that a real active save produces one recoverable version, an identical save adds none, reopening does not import files, an identical save after restart adds none, and a second distinct save remains searchable. The synthetic foreground fixture emits roughly thirteen observations per second; the Search assertion therefore uses the filename rather than expecting file events to occupy the latest unfiltered fifty observations.

Packaged integration checks also pass for save-burst coalescing, exclusions/reopen/reconnect, checkpoints/Keep/deletion, original-byte file recovery, DOCX/PDF previews, captured-content Search/backfill and explicit overwrite preservation. Older fixtures now issue explicit named-file saves after active recording acknowledgement; pre-session writes and paused edits are deliberately not imported.

Final validation:

- `npm run check`: native-lock, typecheck, lint, formatting and **662 tests / 76 files passed** (248.15 s for tests). Initial failures were legacy fixtures expecting baseline import; they were changed to perform actual active-session saves without changing production deadlines.
- Final Electron Forge Windows verification package: passed after the overlapping-root optimization.
- Latest package's automatic recording, performance/restart, checkpoint and file-recovery suite: **6 passed** (1.1 min).
- Before the final overlapping-root optimization, both packaged document-preview cases, both captured-content Search cases and the overwrite-preservation case also passed with the change-only collector. No single new full 33-case app-suite pass is claimed.
- Final documentation formatting and `git diff --check`: passed. No application processes from the verification output remained after testing.

The verification build is `apps/desktop/out/changed-files/Rewind-win32-x64/Rewind.exe`. Automated profiles/files are marked synthetic; no personal file scan, document-body inspection or activity capture was used in testing. Existing retained history follows its existing retention/Keep/deletion policy.

Close old Rewind instances and run from the repository root:

```powershell
& '.\apps\desktop\out\changed-files\Rewind-win32-x64\Rewind.exe'
```

Physical Known Folder redirection/OneDrive/offline acceptance, long-duration whole-system profiling, signing and installation remain separate acceptance work. These local changes were not pushed, merged or published, and older installer/ZIP artifacts do not contain them.
