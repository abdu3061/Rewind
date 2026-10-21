# Browser integration and installation plan

Owner: Mohammad Poorhamadi, with Rasit approving consent, lifecycle, wire contracts, host security, and installer changes. **Status: inactive extension implemented; Native Messaging proposed, not implemented or registered.**

## Starter behavior

`npm run build:extension` creates `apps/browser-extension/dist` with `manifest.json`, a module service worker, and a status popup. Load this directory unpacked in Chrome/Edge developer mode. The service worker only sets the action title on installation. It registers no tab/navigation/content listeners, stores no history, opens no network/native connection, and requests no permissions. `incognito: not_allowed` excludes private use.

The source separates background, permission policy, extraction interface, and communication interface. No Readability or native host dependency is installed yet. Chrome/Edge end-to-end native collection is not verified by the starter's desktop tests.

## Proposed shipping path

Use the browsers' Native Messaging API rather than treating Electron as an arbitrary reachable Node server. A browser launches a separately installed host executable; it does not directly attach to the running desktop Node process. The proposed host name is `com.rewind.bridge`. The extension service worker owns `connectNative`, validates content-script senders and metadata, and forwards bounded versioned messages to the host. The host relays only approved events to the engine through a Windows named pipe.

```mermaid
sequenceDiagram
  participant X as Extension service worker
  participant B as Chrome/Edge
  participant H as Installed native host
  participant E as Utility-process ingestion
  X->>B: connectNative after consent and session handshake
  B->>H: Start registered host with caller origin
  H->>E: Authenticate user-bound pipe and protocol
  E-->>X: Active session and short-lived generation
  X->>H: Validated, bounded permitted observation
  H->>E: Validate and forward
  E->>E: Recheck session, consent, generation, exclusions
  E-->>X: Pause/end/revocation; discard queued observations
```

This is a recommendation based on official [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) and [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging). The host executable/runtime, named-pipe authentication design, and versioned handshake are an approval gate. No registry changes or local listener are part of initialization. Native Messaging reduces the exposed network surface; it does not by itself authenticate the local pipe or guarantee consent.

## Windows packaging requirements

The future installer must install a real executable host (not a TypeScript file or arbitrary Node process), a native-host manifest with `type: stdio`, its executable path, and exact `chrome-extension://<id>/` allowed origins. Chrome and Edge store IDs may differ. Unpacked development IDs must be recorded and explicitly allowed; no wildcard origins.

Register the full manifest path per user under:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.rewind.bridge
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.rewind.bridge
```

The registry key's default value points to the installed host manifest. Installation/update/uninstall must maintain/remove both registrations and manifests without leaving orphan executables. Prefer per-user install with no administrator requirement. Browser store publication is a separate distribution step; installing an extension does not install the native application.

The host reads/writes length-prefixed UTF-8 JSON on binary stdin/stdout. On Windows the 32-bit length prefix is little-endian. Protocol logs go to stderr, never stdout. Use an application limit such as 256 KiB, below Chrome's host-to-browser maximum, and reject malformed/oversized/unknown-version messages. The caller origin argument must match the manifest allowlist. The same-user pipe needs ACLs and an independently approved handshake/capability mechanism, no world-readable static bearer token, no generic filesystem/command execution, and bounded queues/timeouts/reconnects.

## Permissions and lifecycle gates

Request only the metadata/native permissions actually needed after an approved consent flow. Optional article extraction needs a separate user gesture and per-site host permission, with permission revocation and excluded-site handling. No `<all_urls>` or content scripts are granted by the starter. `activeTab` alone does not enable continuous background history; the final permission set must be tested and explained.

Re-check private/incognito state defensively, browser focus, restricted/internal pages, sender extension/frame/tab identity, HTTP(S) scheme, credential/query redaction policy, payload limits, and site exclusions. Strip captured HTML; run Readability on a cloned permitted DOM, retain bounded plain text, and record unsupported cases. Do not inject into built-in PDF viewers or private pages by assuming all tabs are ordinary HTML.

A restarted MV3 worker or native host must reconnect through a fresh desktop session/generation handshake. Do not persist an activity backlog in browser storage by default. End/pause/revocation invalidates generations, disconnects capture, and discards queued content on both sides. Acceptance tests must include both Chrome and Edge, stop races, worker termination, missing host, wrong extension ID, locked sessions, and uninstall. No bridge may activate merely because the desktop app is installed.
