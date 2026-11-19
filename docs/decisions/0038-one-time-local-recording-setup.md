# ADR 0038: One-time local recording setup

19 November 2026. Implemented locally for Rasit's architecture/privacy review; no remote integration or release approval.

The product owner requested an install/open/approve flow that works without manually selecting each application or file, with exclusions added afterward. This explicitly revises the earlier requirement for renewed Windows/file approval on every app launch. The working scope is Desktop, Documents and Downloads, not unrestricted access to every drive.

## Decision

Dashboard and Settings offer **Allow and start recording** after displaying scope, actual Windows-resolved locations, remembered startup behavior and capture limits. One strict confirmed `recording.configure` command authorizes local application metadata and supported saved files. Existing profiles remain off until this new approval; previous manual launch grants do not opt users in. Native identity, NTFS, reparse, private-storage, size, exclusion, encrypted storage and quota checks remain enforced.

Main supplies at most three OS-resolved locations in private bootstrap metadata. A renderer cannot submit recording roots. Synthetic mode substitutes only directories beneath its marked temporary profile, and the worker independently rejects outside paths. Locations pass existing native protected-folder admission before enrollment. Unavailable locations are reported; zero admitted default locations leaves both grants off. Approved locations are persisted in encrypted settings so later OS path changes cannot silently expand scope or mislabel approved locations. Additional user-selected folders remain supported.

The supervisor still accepts only secure default-off worker ready. On the first worker boot of a desktop launch, the utility may renew remembered local grants and start a new session after that handshake. Reconnect never renews them. A session recovered paused after an interrupted run remains paused until Resume. Normal close/quit ends and drains the session; a later opening starts a new session if automatic approval remains enabled. Pause/End stop this session without disabling next-launch behavior. Turning off automatic recording, revoking local recording/file permission, adding/removing a protected folder or explicit storage maintenance disables future automatic starts. A newly selected folder needs explicit approval of the expanded scope; selection alone cannot enroll it into future remembered capture. Quota/startup failures remain fail closed.

Settings exposes full Windows file/folder path exclusions alongside application exclusions. Capture and indexing recheck those denials; exclusions do not erase old history. An exclusion change drains work and continues an active automatic session only after installation of the new policy. Manual sessions retain explicit Resume. Newer privacy/stop operations fence outstanding setup before grant or activation.

Browser setup/extension approval, native credential entry, cloud approval, per-question sharing reviews and recovery confirmations remain separate. No browser host is registered by this setup. No screenshots, keystrokes, unsaved buffers, desktop layout or arbitrary application memory are captured. Existing bounded capture skips unsupported, hidden/system/cache/reparse files and may miss saves; status must disclose those limits. The subsequent [ADR 0039](0039-bounded-folder-scan-continuation.md) replaces fatal large-folder/long-entry overflow with bounded scan continuation and visible skipped-entry warnings.

## Verification and release

Encrypted-runtime tests cover initial-off behavior, actual default-folder capture, exact-file exclusions, restart, durable revoke, synthetic-root enforcement, revocation during native validation and failed approval persistence. Supervisor and packaged UI regressions cover first-boot renewal, real saved versions, exclusions, reopen, pause/revoke and worker crash/reconnect. Actual results are recorded in the [implementation report](../audit/automatic-recording-setup.md).

The prior unsigned archives retain their original provenance. Physical Known Folder redirection/OneDrive/non-NTFS acceptance, independent security review, signing, installation and distribution remain separate gates.
