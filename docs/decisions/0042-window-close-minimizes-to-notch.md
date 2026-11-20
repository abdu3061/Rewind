# ADR 0042: The window close button minimizes to the notch

20 November 2026. Requested by the product owner during the UX audit (item 19). Approved by Rasit on 20 November 2026 and merged into `main`; first released in 0.1.0-beta.3.

## Problem

Closing the main window quit Rewind, ending and draining the session. The only warning was a footnote on the Dashboard. Rewind is meant to stay "within reach" in the notch, and most Windows tray applications keep running when their window is closed, so people lost sessions they meant to keep.

## Decision

- The main window's close button (and a Windows `WM_CLOSE` such as `CloseMainWindow`) **minimizes** the window, which shows the compact notch through the existing minimize path. The session and any approved sources keep running.
- Quitting stays explicit and keeps the existing acknowledged shutdown (`QuitGuard`: end, drain, close storage):
  - the tray menu's **Quit Rewind**;
  - `Rewind.exe --quit`, which the running instance receives through the existing single-instance `second-instance` hand-off and turns into `app.quit()`. The second process exits immediately, as before.
- Windows log-off, restart and shutdown are never blocked: the window's `query-session-end` and `session-end` events mark the app as quitting so close proceeds.
- Once a quit begins (`before-quit`), the close handler no longer intervenes.

## Privacy

Rewind never records invisibly. The window is minimized, not hidden, so it keeps its taskbar button. The notch shows its recording dot, and the tray icon and tooltip show the session and collection state. Pause, End, revoke and all consent rules are unchanged; this ADR changes only what the close button does. The Home footnote tells people that closing keeps Rewind in the notch and how to quit.

`--quit` lets any process running as the same Windows user request a graceful shutdown. That user can already terminate the process; a graceful quit is the safer of the two, because it acknowledges the session end and drains sources. It carries no data and grants nothing.

## Supersedes

This replaces "Window close quits" in the architecture notes, and the "Normal close/quit ends and drains the session" wording in ADR 0038, which now applies to quit only. A later opening still starts a new automatic session if automatic recording remains enabled.

## Verification

- Packaged app test (`notch.spec.ts`): closing the main window minimizes it and keeps the session active; `app.quit()` (what the tray item calls) then ends the session, and the next launch shows it ended.
- `scripts/verify-release.mjs` (hardened release smoke): `CloseMainWindow` must leave the process running without `DESKTOP_STOPPED`, then `Rewind.exe --quit` must exit 0 with `DESKTOP_STOPPED` logged.
- `scripts/test-windows-installer.ps1`: closes the window, then falls back to `--quit` if the process is still running, so it works for both earlier betas and newer builds.
- Not yet verified on a physical machine: Windows log-off/restart while recording, and the installer acceptance run on a disposable runner.
