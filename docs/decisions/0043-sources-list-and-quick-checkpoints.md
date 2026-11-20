# ADR 0043: One recording-sources list and quick checkpoints

20 November 2026. UX audit Phase 3 (items 7 and 11). Approved by Rasit on 20 November 2026 and merged into `main`; first released in 0.1.0-beta.3. Presentation only: no engine, contract or consent-rule changes.

## Problem

Permissions were spread across five "Allow … for this launch" buttons on three pages (Windows activity, protected files, Chrome/Edge, Gemini, plus the one-time setup). People could not tell at a glance what Rewind was allowed to record. Saving a checkpoint required picking every file version and activity by hand.

## Decision

### Recording sources

Home shows one **Recording sources** card. Each source has a row with its name, what it records, a status chip and one action:

| Source           | Status                                  | Action                                                        |
| ---------------- | --------------------------------------- | ------------------------------------------------------------- |
| Windows activity | On · automatic / On until restart / Off | Allow Windows activity or Revoke recording permission, inline |
| Protected files  | same                                    | Manage → Files                                                |
| Chrome and Edge  | On until restart / Off                  | Manage → Settings › Browsers                                  |
| Gemini questions | On until restart / Off                  | Manage → Settings › Gemini                                    |

The inline Windows actions call the same `privacy.update` command as before, with the saved exclusions; exclusions are edited only in Settings › Recording. Every other grant still happens on its own page, behind its existing disclosure and confirmation. Browser approval still also needs the extension. Gemini still needs a saved key, cloud approval and a review of every question. The one-time setup card is unchanged and still leads Home until automatic recording is on. Status text says "until restart" instead of "for this launch".

### Quick checkpoints

**Save checkpoint** now saves everything loaded for the chosen session by default: up to the engine's existing limits of 100 file versions and 200 activities. The hint states exactly what will be included. **Choose items…** opens the original picker for a hand-picked checkpoint. The engine revalidates every selection, including the 64 MiB limit, exactly as before.

### Live lists

The saved-checkpoint list reloads when retained history changes (for example a checkpoint saved from the notch), and Files already polls, so their manual Refresh buttons were removed.

## Not done

Audit item 17 (chip-style exclusion editors with an "Add folder" picker) is deferred. A folder picker for exclusions would need a new native dialog command over IPC, which is a security-reviewed surface. The text areas remain.

## Verification

Packaged app tests use the Sources card's Allow/Revoke buttons on Home, a new test covers quick save without opening the picker, and the existing picker tests now open **Choose items…** first.
