# ADR 0011: Recording worker and launch-scoped consent

Status: implemented locally for Rasit's review; no remote merge or release approval.

The encrypted store in ADR 0010 is hosted with the session coordinator and Windows collector in one Node-capable Electron utility process. Main retains window/tray ownership, exact renderer/frame/location authorization, Windows safeStorage access and worker supervision. The renderer receives narrow validated DTOs only. Infrastructure never imports Electron.

Main unwraps a random database key through asynchronous Windows DPAPI and transfers it to the worker. SQL, migration/integrity checks and window polling execute outside the main/renderer event loops. The exact native Windows x64 prebuild is packaged outside ASAR; unsupported platforms fail closed. There is no in-memory or plaintext production fallback.

Messages have bounded payloads, strict versioned schemas, boot nonces and request IDs. Every leaf reply is validated in main and preload. Startup and command deadlines, a bounded pending map, parent heartbeats and observed worker exit fence failed generations. A retry cannot overlap a worker whose termination is unverified. Worker diagnostics are drained without logging private text. A lost parent lease shuts the worker down.

Control overload follow-up: stop/settings requests interrupt adapter timers outside the lifecycle/read queue, while acknowledgements still wait for checked drain and helper close. A failed interruption remains a failed control operation even if later cleanup succeeds. If main's pending map is saturated, stop/revocation terminates the worker and reports unavailable rather than dropping the request or claiming a successful stop. The next reconnect expires approval and restores interrupted history safely.

Collection consent is explicit and expires whenever the worker restarts. Exclusions persist in the encrypted store. Saving a grant first invalidates the old generation, quiesces collectors, pauses an active session, and persists settings on the coordinator's lifecycle queue. It never resumes automatically. Revocation invalidates authority synchronously before queued cleanup; late events are rejected. Failed settings persistence cannot install a grant. Read-model queries share the lifecycle queue so they cannot expose a candidate session before commit.

Only the Windows collector is registered. Browser and filesystem input are unavailable, and the engine rejects resource events without an authorization port. Browser processes are excluded from generic window-title collection because a desktop window cannot prove nonprivate browser context. Website/folder exclusions remain engine defenses tested with synthetic events, not a claim of browser/file collection support.

An acknowledged normal quit ends the current session, drains ingestion and closes the store before main terminates the worker. A crash cannot truthfully acknowledge an ended session. On the next successful encrypted open, an interrupted active session receives a capture-gap record and is restored paused, with consent off. An explicit reconnect and fresh grant are required. Historical records are available after collector failure when storage remains verified.

Tests use an explicit synthetic fixture launch flag restricted to a marked, nonsymlink direct child of the OS temporary directory. It selects a fixed synthetic observation source and isolated userData. Invalid fixture configuration exits instead of selecting production recording. There is no public IPC switch for it. Packaged tests must use this fixture and never observe real desktop activity.

Evidence: encrypted/native utility probe on Electron 44.11.3; packaged worker/session smoke; worker-client crash, timeout, stale-generation and invalid-response tests; actual encrypted worker-runtime consent/exclusion/restart/save-failure tests; coordinator persistence/revocation/read-serialization tests. Further UI/workflow evidence belongs in the integration report.
