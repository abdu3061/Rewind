# Architecture decisions

Accepted initialization decisions reflect the explicit approved stack/scope. Proposed production choices require Rasit's approval and feasibility evidence before implementation.

| ADR                                             | Status                                                | Decision                                                  |
| ----------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| [0001](0001-workspaces-and-build.md)            | Accepted for initialization                           | Lightweight private source workspaces and Forge/Vite      |
| [0002](0002-electron-security-boundary.md)      | Accepted for initialization                           | Validated capability IPC and sandboxed renderer           |
| [0003](0003-in-memory-session-staging.md)       | Accepted for initialization                           | In-memory sessions in main until utility services exist   |
| [0004](0004-browser-native-messaging.md)        | Proposed                                              | Native Messaging host plus authenticated local pipe       |
| [0005](0005-encrypted-storage-gate.md)          | Proposed implementation; encryption requirement fixed | Encrypted SQLite/blob/key feasibility gate                |
| [0006](0006-evidence-and-recovery-contracts.md) | Accepted contract direction                           | UUID/UTC evidence references and user-controlled recovery |

For a new decision: state context, options, recommendation, consequences, owner/status, and acceptance evidence. Do not mark a proposed binding/protocol approved because a placeholder interface exists.
