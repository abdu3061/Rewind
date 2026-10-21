# ADR 0003 — In-memory session staging

Date: 17 October 2026. Status: Accepted for initialization; temporary hosting choice. Owner: Rasit.

Implement the synchronous lifecycle in platform-neutral `packages/engine`, injecting clock and UUID generation. Main constructs one instance; UI and tray use it. There is no persistence, collector coordinator, OS monitoring, snapshot store, or cloud operation. Starting a session does not change consent.

Allowed transitions are missing/ended → start → active; active → pause → paused; paused → resume → active; active/paused → end → ended. Reads work everywhere; invalid transitions preserve state. An ended session remains visible until the next start. Copy returned state and keep timestamps ordered across backward clock changes.

Running a separate idle utility process now would add transport/restart code without a background service. The next phase introduces the approved Node utility-process host and moves persistent/collection orchestration behind a versioned transport. Engine tests stay independent of Electron. Async operations will require serialized commands, shutdown acknowledgements, durable state decisions, and crash recovery.

The starter quits on window close and loses state. The product plan's tray-only session lifetime is deferred until durable lifecycle/collector shutdown exist; UI/docs explicitly say so. This milestone does not implement persistent session history.
