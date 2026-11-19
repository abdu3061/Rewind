# Timeline file-backup repair

19 November 2026; local uncommitted work on `feature/automatic-recording-setup`.

Source review confirmed that initial recovery copies were being displayed as saved-file activity. The fix separates recovery-backup rows from default activity queries and accurately labels both. Original-byte protection remains available in Files/Search, while native saves observed during recording and foreground app observations remain in Timeline. No personal documents, activity history or databases were inspected for this repair.

See [ADR 0040](../decisions/0040-file-backups-and-session-activity.md) for query compatibility, native timestamp classification and retained-history limits. The checkpoint evidence picker explicitly includes backup events, labels them correctly and preserves file-only checkpoint creation. Existing protection scope is retained; hiding backups in Timeline does not stop their collection or delete history.

Verification:

- Final `npm run check`: native-lock, types, lint, formatting and **657 tests / 76 files passed**; tests took 211.55 s. An earlier concurrent run hit the existing native folder-proof deadline in an overwrite fixture; the complete sequential run passed without changing deadlines.
- Rebuilt Windows verification package with current main/worker/preload/renderer/native assets: passed.
- Broader packaged run: **32 cases passed**; one checkpoint-picker regression from the new query default was found and corrected. This is not represented as a single fully passing 33-case run.
- Final rebuilt package: the **five automatic-recording/file-protection cases passed**, including the exact Timeline regression, native initial/saved versions, app observations, Search, exclusions/restart/reconnect and original-byte previews. The checkpoint case subsequently **passed separately** (6.9 s), including Keep/deletion, encrypted restart, rename/Unkeep and removal. Its added label assertion matches the containing evidence group because the displayed row also includes a localized timestamp.
- Final changed-file formatting and `git diff --check`: passed.

All app tests used marked temporary synthetic profiles/files. No personal folder scan or real history inspection was used for diagnosis. No installer, signing, publishing, remote PR, push or merge was performed.

Close any old Rewind instance, then launch the updated build from the repository root:

```powershell
& '.\apps\desktop\out\timeline-recording\Rewind-win32-x64\Rewind.exe'
```
