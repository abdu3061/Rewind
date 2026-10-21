# ADR 0004 — Proposed browser transport

Date: 17 October 2026. Status: **Proposed; implementation requires Rasit's approval.** Owner: Mohammad Poorhamadi, approver: Rasit.

Chrome/Edge extensions cannot simply attach to an arbitrary Electron Node process. Recommend browser Native Messaging: a separately installed executable host registered to exact extension origins, with bounded length-prefixed stdio messages, relaying to an authenticated same-user Windows named pipe into the utility ingestion service.

This avoids opening a general loopback HTTP/WebSocket endpoint. Loopback would still require pairing/authentication, origin enforcement, quotas, and lifecycle controls; it remains an alternative only if the native-host packaging spike shows a serious incompatibility. Native Messaging itself does not authenticate the host-to-desktop pipe or authorize collection.

Approval evidence: executable packaging/runtime choice, Chrome/Edge development/store extension IDs, per-user host registration/update/uninstall, origin/protocol/size validation, pipe ACL/authentication, consent/session/generation handshake, worker/host restart and pause/end race tests. No host, registry writes, pipe, or nativeMessaging permission is implemented now. See [installation and protocol requirements](../browser-integration.md) and official [Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) / [Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging) documentation.
