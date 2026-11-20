# ADR 0040: Distinguish recovery backups from session activity

19 November 2026. Implemented locally for Rasit's contracts/architecture review.

## Problem

Automatic local protection takes original-byte recovery copies of existing supported files in the approved roots. Each initial copy uses the existing `file-change` event with `change: captured`. Timeline rendered these as generic saved-file observations. After bounded scanning began covering larger folders, users reasonably interpreted this flood as evidence that they had used all those files.

## Decision

Timeline excludes `change: captured` recovery-backup events by default. An optional strictly validated `includeFileBackups` query flag includes them; the explicit **Include recovery backups** filter exposes that choice. Filtering occurs inside encrypted storage before ordering, paging, keyword matching and LIMIT. It therefore also fixes existing retained history without rewriting or deleting it, and cannot hide subsequent actual changes behind pages of baseline events. Search includes backups initially because they remain useful recovery evidence.

An observed content-hash change remains an `updated` event. A first observation with a verified native UTC write stamp within the current collector run is also classified as a saved change, so newly discovered saves do not disappear with baseline backups. Old or unknown adapter stamps and periodic same-content refreshes remain `captured`. Native write time only classifies evidence: it never grants read authority or proves which person or application saved or read a file. A resumed collector uses its new run boundary, so an imported file changed while paused is not presented as an active-run save solely because it is discovered after Resume.

Backup rows explicitly say **Recovery backup saved**, without suggesting that the file was opened or changed during the session. Actual changes say **Saved-file change observed**, with no app/person attribution. Foreground application observations remain separate and continue to query only the current foreground window. No app inventory, keystrokes, screenshots or unsaved buffer capture is introduced.

Original bytes, file versions, checkpoint membership, retention/Keep, exclusions and recovery remain unchanged. The checkpoint evidence picker explicitly includes backup events on initial and older pages and labels them **Recovery backup**, preserving file-only checkpoint creation without describing those events as file use. Older `captured` records cannot reliably be reclassified as initial backups versus first saves; they remain accessible through the backup filter, Files, Search and existing checkpoints. The independent product choice to stop importing existing files is not inferred from a display correction; no unanswered preference question changes the approved protection policy.

## Verification

Synthetic encrypted-storage tests put newer backup records ahead of actual activity and verify default paging, keyword/type filters and explicit backup inclusion. Collector tests distinguish old initial stamps from first-observed active-run saves. Strict contracts reject malformed query flags. Packaged tests verify baseline versions in Files, clean default Timeline, labeled backup opt-in, a subsequent saved-file change, preserved app observations and backup discovery in Search. Existing file preview/recovery tests continue to protect original-byte behavior.
