# Rewind 0.1.0-beta.2 for Windows x64

Rewind is an early evaluation beta for local work-session history and saved-file recovery. This release is unsigned. Windows may show a publisher/trust warning; use only the download from the team's GitHub release, check its SHA-256 value, and follow your organization's software policy.

This update replaces the generic installer animation with a compact Rewind setup screen, clear installation/first-launch text and matching application icons. Open Rewind from the installed Desktop or Start Menu shortcut after setup; running `Rewind-Setup.exe` again starts installation again.

![Rewind Windows setup](https://github.com/abdu3061/Rewind/releases/download/v0.1.0-beta.2/installer-preview.png)

## Install and start

1. If Rewind is running, choose Quit first. Download `Rewind-Setup.exe` and install it under your Windows account. Alternatively, extract the entire portable ZIP and open `Rewind.exe`; keep all its neighboring files together.
2. Open Rewind. Recording starts off. Review the locations and exclusions before approving automatic local recording.
3. Approval covers the verified Desktop, Documents and Downloads locations shown by setup. Supported files are copied only when created or changed during an active recording session. Existing files are not imported.
4. Use Pause or End to stop collection. Turn automatic recording off in Settings to keep it off on later openings. Minimize shows the floating notch; closing the main window or choosing Quit shuts down recording.
5. To recover a captured saved version, open Files, select the version and confirm Save a copy. Test this with a disposable file first. Keep an independent backup of important work.

## What this beta does

- Records approved foreground application/window activity and supported saved-file changes in local encrypted history.
- Provides Timeline, Search, retained versions, supported text/DOCX/PDF previews and confirmed recovery copies.
- Groups retained versions and activity into named checkpoints. Keep protects that retained evidence from ordinary cleanup.
- Remembers an approved automatic local setup for normal openings. Interrupted sessions stay paused, and reconnecting the recording service does not silently resume capture.
- Offers separate, optional Chrome/Edge metadata recording after desktop setup, manually loading the bundled extension and approving both sides. Use Settings to open the extension folder. Private browsing is excluded.

## Limits and known issues

- Windows x64 only. ARM64 and other operating systems have not been accepted for this beta.
- This is saved-file history, not a full-computer backup, screen recording or exact desktop-layout restore. Unsaved edits, files before their first captured save, and work while collection was paused cannot be recovered.
- Capture is limited to supported file types, ordinary verified local NTFS locations, the active approval and current exclusions. Locked, oversized, protected or unavailable files may not be captured. File-notification overflow is reported as a gap; check recording status during a session.
- Physical OneDrive/redirection/offline-file, multi-monitor/high-DPI and long-duration whole-system performance acceptance remain incomplete.
- The archive and hardened executable have automated verification. Visible setup, automatic first launch, correct icons, normal shortcut launch, acknowledged shutdown, uninstall with history retained and same-version reinstall passed on disposable GitHub-hosted Windows machines. Installing beta 2 over beta 1 also preserved the synthetic encrypted profile and protected key. Interrupted/future upgrade paths and independent security review remain outstanding; do not treat this beta as a certified backup or production release.
- Gemini is optional and separately off by default. Native key entry and a live account request have not received manual acceptance; cloud use is not required for local recording, Search or recovery.
- Updates are manual. Install a newer accepted version to update; do not downgrade a migrated history database. Removing the application retains local encrypted history. Recovery/exported files are independent ordinary files.

## Privacy and support

History remains on the local computer. No keystrokes, clipboard contents or screenshots are collected. Optional browser recording and Gemini have separate approvals. Ordinary logs contain fixed operational codes, rather than document contents, paths or keys.

Report the release version, what you expected, what happened, and operational error codes through the repository's Issues page. Do not attach personal history databases, document bodies, credentials, full paths or browsing history.

The release includes Electron/Chromium licenses, a runtime notice inventory and additional native dependency notices/source references under `resources/notices`. The team's original code remains `UNLICENSED`; this release does not add an open-source license. Third-party components retain their own terms.
