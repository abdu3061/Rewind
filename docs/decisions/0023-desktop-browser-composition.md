# ADR 0023: desktop browser setup and recording composition

18 November 2026. Implemented locally on `feature/core-functionality`, pending Rasit's final architecture and security review. No remote merge, release, distribution or production registration is performed by verification.

## Decision

Compose the previously verified browser components in the desktop utility process. Main supplies only its own executable and packaged/development asset location through private worker initialization. The worker verifies assets, fingerprints the desktop image, discovers installed Chrome/Edge executables at known locations, loads encrypted setup ownership and starts the authenticated passive broker only for a verified existing installation. Startup neither repairs registration nor restores recording approval.

Expose narrow validated setup, removal, repair, status, approval and website-exclusion capabilities. Renderer input cannot supply a host name, asset path, native frame, receipt, executable or destination. Opening the extension folder is a separate main-owned capability that verifies the assets and opens the fixed extension directory. It returns no filesystem API. Browser setup uses the existing explicit confirmation and encrypted pending-operation journal from ADR 0022.

Register `BrowserCollector` beside the Windows and selected-folder sources. Browser events pass exact staged authorization and the coordinator's current session/policy checks before encrypted publication and timeline notification. Windows activity approval does not grant browser approval. Extension approval, desktop browser approval and a committed active session are all necessary. Website policy changes revoke desktop browser approval and pause the session; resumption requires an explicit action. Stop requests retain reserved worker admission even when the ordinary request budget is saturated.

Browser failure immediately stops leases and client queries, then persists its capture gap before reporting source unavailability to the coordinator. The coordinator invalidates the run and clears every launch-scoped approval before publishing unavailable status. Clearing authorization in the browser's early status callback would reject its own queued gap and could publish inconsistent collection/permission state; the coordinator owns that transition instead. Shutdown revokes and drains sources before closing the native broker, installation helpers and encrypted store. Failed or uncertain closure remains an error.

## UI and installation

Settings provides installed-browser choices, confirmed setup/removal/repair, fixed extension-folder opening, website exclusions, separate launch approval and actual setup/bridge/capture status. The saved-event count comes from confirmed backend writes. Setup does not install the browser extension. Users load the verified extension directory unpacked through Chrome/Edge Developer mode, then explicitly allow the extension and desktop and start/resume a session. The existing public development identity is pinned; browser store publication and signed installer integration remain separate work.

No new dependency is introduced. `BrowserOperations` stays in desktop composition because it combines OS/process/registration and storage adapters; the engine retains only contracts/ports and authorization. Renderer uses existing design tokens and has no Node, database or native access. Native setup files contain code and nonsecret host configuration; history, receipts and original-byte captures remain encrypted.

## Verification boundary

Packaged tests now exercise the real main, preload, utility, coordinator, cipher store, native registration/host and normal extension popup on both installed Chrome and Edge. Each test uses a fresh marked temporary profile, nonce host namespace, real native installation and routed synthetic pages. A fixture override is accepted only from the already validated temporary-profile command line and a bounded strict fixture file. The worker confines those assets to that profile's fixed `browser-assets` directory. Ordinary synthetic app profiles cannot register a host; production profiles cannot select the test namespace through public controls.

The flow verifies canceled and confirmed setup, dual approval, zero browsing queries before authorization, Unicode title/URL redaction, exclusions, pause/resume/end, timeline and FTS, kept checkpoint evidence through deletion, database/journal confidentiality markers, app restart with approval off, actual owned-host termination, browser-specific disconnect gap, service reconnect with fresh approval required and confirmed removal. Browser storage contains only the random profile tag. Settings screenshots are inspected for layout. Existing provider/native-session tests separately cover private/unfocused contexts, extension-worker restart, invalid senders, stale leases and framing failures.

This proves the tested local Windows x64 development workflow, not clean-machine signed distribution, independent security certification, browser lock/idle behavior, article extraction or all future browser versions. Those unavailable capabilities remain explicit. Optional overwrite and conditional Gemini remain unfinished core-goal work.
