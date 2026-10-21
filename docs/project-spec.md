# Project specification

Status: initialization, 17 October 2026. Product owner and technical approver: Rasit (`@RXD3`). This document refines the existing plan without expanding version one.

## Product and scope

Rewind provides temporary local memory for a computer work session. Users explicitly start a session, select folders to protect, inspect evidence on a timeline, search it, and recover previously captured saved files. Windows, Chrome, and Edge are the first supported platforms.

Example questions include which machine-learning website was visited, work around 2 PM, which PDF preceded an editor session, and which captured Word version can be recovered. Answers cite observations and resources; missing or ambiguous evidence is disclosed.

## Version-one requirements

| Capability          | Required behavior                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions            | Start/pause/resume/end; clear window and tray state. Collection stops on pause/end/quit. Final product may keep an active session in the tray when the window closes, with explicit visible behavior.     |
| Activity timeline   | Foreground applications/window titles, permitted websites, saved file changes, timestamps, idle/lock intervals, and capture gaps. Do not infer reading from a save notification.                          |
| Browser integration | Chrome/Edge MV3 extension; site/app exclusions, explicit metadata consent, separate optional article extraction permissions, no private/incognito data.                                                   |
| Known files         | Files opened through Rewind have verified identities. Watch saved changes in chosen folders even when changed externally. Generic window titles do not prove a path.                                      |
| Search              | Local SQLite FTS5 keyword/date search, followed by optional natural-language evidence search with official Gemini SDK. Citations resolve to recorded sources.                                             |
| Versions            | Initial snapshot after protection starts, followed by captured saved changes for bounded text/code, Markdown, DOCX, and ordinary PDFs. Preserve original bytes; extract searchable text separately.       |
| Recovery            | Preview captured versions; explicit confirmation; save a copy by default. Overwrite requires a verified preserved copy of the current file and a final concurrency check. Any failed prerequisite aborts. |
| Checkpoints         | Named groups of selected file-version IDs, website visits, and project references. Report unavailable captures; Keep retains referenced artifacts beyond normal expiration.                               |
| Privacy/storage     | Collection off by default; consent/exclusions, 72-hour initial configurable retention, quota/deletion controls, encrypted metadata and file copies, OS-protected keys, and retained kept checkpoints.     |

No screen, audio, clipboard, or keystroke capture. No arbitrary application control, unsaved-state restoration, private browser scraping, authentication server, remote database, or cloud file storage. Cloud Gemini is separately optional and initially disabled.

## Limitations that must be visible

- Only successfully captured complete versions can be recovered. No promise applies before baseline capture completes or during gaps/pauses.
- Exact document identity needs a verified path or specifically supported integration. Title matches are candidates, not proof.
- Checkpoints reopen selected resources and offer individual recoveries; they do not restore process memory or arbitrary unsaved edits.
- History and snapshots remain local. With explicit cloud-AI consent, only the necessary question and retrieved excerpts leave the device.
- Local retention cannot delete provider-retained data or guarantee forensic erasure on SSDs, OS backups, or external copies.
- Unsupported, locked, oversized, changing, image-only, encrypted, or malformed documents can produce gaps; never fabricate a successful capture or answer.

## Initialization acceptance

The present milestone implements only repository/tooling, shared contracts, an in-memory session state machine with tests, validated Electron IPC, a neutral React shell, an inactive extension, module boundaries, CI configuration, and team documentation. No persistence or protection is implied by a session being active. Tray controls manipulate the same service as the UI. Closing the current starter exits; durable session recovery and tray-only operation come later.

## Later enhancements

After version one is proven: VS Code and tested document integrations, better move tracking, semantic retrieval/local embeddings, OCR and richer comparisons, scheduled/grouped checkpoints, Firefox/macOS and later Linux investigation, optional local AI. Any cloud backup/sync requires a separate approved design for account/key recovery, conflicts, consent, and deletion. None is a dependency of this scaffold.
