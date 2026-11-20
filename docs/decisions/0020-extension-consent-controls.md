# ADR 0020: Normal extension controls and restart-scoped consent

Status: implemented locally for Rasit's review. Desktop host setup/registration and worker/public UI composition remain in progress. Owners: Rasit for privacy/integration, Mohammad Poorhamadi for browser/native transport, Hacer Dilara for UI/preload integration and Abdullah for UI review.

## Context and decision

ADRs 0018–0019 establish the authenticated native relay, engine leases, focused provider and native client session. A usable client also needs explicit controls and a normal background entry. Activating listeners must not activate monitoring or restore a previous grant.

The normal MV3 background now composes those tested components. Declared permissions are `tabs`, `nativeMessaging` and `storage`; there are no host/content scripts, screenshots, clipboard/history access, external connection listeners or incognito support. Browsing queries still require an explicit Allow action, an authenticated desktop connection, current engine browser approval and an active session lease. There is no startup native connection or browsing query. No new dependency is introduced.

Only a random nonsecret profile UUID persists in `storage.local`. Creation is verified by readback; failures disable the service instead of using an unverified identity. Consent, URLs, titles, capabilities, queues and site lists do not persist in extension storage. Every background execution starts off. Install/startup, browser permission removal, disconnect, expiry and protocol/send failure revoke approval and supersede pending grants. Reconnection is explicit. A native connection may remain passive after local Stop so its drained acknowledgement is delivered; no further browsing query starts. Two-second polling can miss brief visits and does not inspect past history.

The popup exposes current backend-confirmed permission/connection/authority/pending state. It never claims an observation was saved merely because `postMessage` returned. Users inspect the desktop timeline for persisted evidence. Its styles reuse the desktop's Segoe UI, light palette, borders and focus treatment. It renders static controls/status, never captured markup. The client is operational in the verified fixture composition; the ordinary desktop app still lacks owned setup/registration and worker/public consent wiring at this checkpoint.

## Control authorization

Controls accept only strict status and boolean-permission commands from this extension ID, exact private `status.html` URL and origin. Known subframes are rejected. Browser contexts additionally verify the document and main frame for status/grants. Normal command admission is bounded to eight, including asynchronous authorization; privacy denial retains a reserved path. Intent revisions prevent an earlier grant from overtaking a later stop during document proof or browser permission checks. Trusted lifecycle/failure revocation invalidates both stages.

Actual Chrome/Edge 157 expose tab document tokens as 32 hexadecimal digits, distinct from Rewind's UUID domain IDs. Controls validate browser tokens separately, also accepting the documented UUID form, and require an exact current context match. Rewind domain schemas are unchanged.

Actual native popup senders omit `documentId`, `tab` and `frameId`. For these senders, status/grants require exactly one live nonprivate POPUP context for the exact owned URL/origin at frame zero. The page cannot host or be embedded in frames: manifest CSP fixes both `frame-src 'none'` and `frame-ancestors 'none'`, and no page is web-accessible. This is required for popup authorization; absence of a document ID alone never grants access. Denial is admitted immediately from the exact owned non-embeddable controls page, so closing a popup cannot delay a stop behind context lookup. Raw/expanded commands, modified control URLs, other extensions and unknown contexts cannot grant recording.

Chrome 116+ is required for `runtime.getContexts`; verification uses installed Chrome/Edge 157. See the official [Runtime API](https://developer.chrome.com/docs/extensions/reference/api/runtime) for optional sender fields and contexts, [Action API](https://developer.chrome.com/docs/extensions/reference/api/action) and [Extension API](https://developer.chrome.com/docs/extensions/reference/api/extension) for popups/views, and [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) for extension storage.

## Development identity and build

A public RSA SPKI key pins the unpacked development ID `coenmeplfkocojebfacfbebinadfijoh` in both browsers. No private signing key was saved or committed. This is a verified development identity, not a store publication ID or credential. Store IDs and signed distribution need separate review. See the official [manifest key documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key).

Vite builds background and popup module entries with shared code and a fixed normal host name `com.rewind.bridge`. Tests override that public name only at build time into generated directories and use scoped `com.rewind.test.<nonce>` registrations. There is no runtime host-name/path override through UI/storage/messages and no automatic production registration.

## Alternatives and evidence

Restoring saved approval would violate restart-scoped consent. Origin-only authorization would omit frame identity. Requiring a UUID sender document ID for every popup fails on actual browsers; separate token validation, context proof and the non-embeddable private popup preserve the intended boundary. Plaintext or synthetic product history is not a fallback for missing setup.

Sixteen controller cases cover identity read/write/readback failure, default-off/restart, browser permissions, admission/denial priority, authorization races, trusted/native revocation, close races, strict controls and location/context validation. Existing provider/session/engine/native failure tests remain intact.

Chrome/Edge end-to-end tests build the normal background, manifest, popup and source modules. Actual native popups perform Allow/Stop; modified URLs and embedding are rejected. Test-only counters prove browsing queries stay off before approval and after pause/restart. An actual worker stop/restart changes an execution nonce, preserves only the profile tag and requires another Allow action. The native host/adapter/engine/cipher path verifies exclusions, redaction, pause/resume/end, denial gaps, FTS, live database/WAL confidentiality markers and encrypted reopen. Data/profiles/registrations are generated fixtures. Playwright can retain a worker object across a replaced execution, so restart proof uses the execution nonce. Full results are recorded in the integration report.
