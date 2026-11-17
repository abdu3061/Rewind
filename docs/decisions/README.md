# Architecture decisions

[ADR 0012](0012-retention-and-snapshot-storage.md) records local retention, explicit deletion, quota/backpressure and the transactional encrypted snapshot direction for the current core integration run.

[ADR 0013](0013-protected-folder-capture.md) records independent file approval, native scoped identity/read guards, bounded reconciliation, atomic encrypted capture, preview expiry and retention freshness.

[ADR 0014](0014-confirmed-recovery-copies.md) records expiring single-use copy proposals, retained-source verification, native CREATE_NEW safety, verified receipts and truthful failure/partial-copy limits. Optional overwrite remains pending.

[ADR 0015](0015-real-evidence-checkpoints.md) records actual same-session version/activity manifests, transitive Keep/FTS/blob retention, management and bounded verified views.

[ADR 0016](0016-independent-browser-consent.md) records the independent default-off browser source gate and supervisor invariants. Native authentication and operational browser integration remain in progress.

[ADR 0017](0017-windows-browser-peer-primitives.md) records tested Windows pipe/process/signature primitives, with no operational transport or host-registration claim.

[ADR 0018](0018-native-relay-and-client-authority.md) records the authenticated relay verified in isolated Chrome/Edge, scoped temporary registrations, lifecycle watches and permissioned client protocol/controller. Normal collection/UI wiring remains pending.

[ADR 0019](0019-browser-engine-leases.md) records the engine lease/staged-admission collector and tested utility native adapter, including actual encrypted history/FTS and isolated Chrome/Edge adapter verification. Product setup, approval and composition remain in progress.

Accepted initialization decisions reflect the explicit approved stack/scope. Proposed production choices require Rasit's approval and feasibility evidence before implementation.

| ADR                                             | Status                                                | Decision                                                                |
| ----------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| [0001](0001-workspaces-and-build.md)            | Accepted for initialization                           | Lightweight private source workspaces and Forge/Vite                    |
| [0002](0002-electron-security-boundary.md)      | Accepted for initialization                           | Validated capability IPC and sandboxed renderer                         |
| [0003](0003-in-memory-session-staging.md)       | Accepted for initialization                           | In-memory sessions in main until utility services exist                 |
| [0004](0004-browser-native-messaging.md)        | Proposed                                              | Native Messaging host plus authenticated local pipe                     |
| [0005](0005-encrypted-storage-gate.md)          | Proposed implementation; encryption requirement fixed | Encrypted SQLite/blob/key feasibility gate                              |
| [0006](0006-evidence-and-recovery-contracts.md) | Accepted contract direction                           | UUID/UTC evidence references and user-controlled recovery               |
| [0007](0007-maintenance-baseline.md)            | Implemented locally; pending Rasit's review           | Preserve runtime privacy gates during branch cleanup and patch Electron |

See also [ADR 0008](0008-audit-stabilization.md): bounded audit fixes implemented locally for Rasit's review, without approving new collection, persistence or AI capabilities.

For a new decision: state context, options, recommendation, consequences, owner/status, and acceptance evidence. Do not mark a proposed binding/protocol approved because a placeholder interface exists.

See [ADR 0009](0009-session-lifecycle-stabilization.md): locally implemented candidate/commit, checked storage lifecycle, consent/run invalidation, acknowledged drain and quit policy. It does not select an encryption binding or enable real recording.

The subsequent [ADR 0010](0010-encrypted-recording-store.md) selects the locally verified encrypted SQLite/key/migration approach, and [ADR 0011](0011-recording-worker-consent.md) records utility supervision, launch-scoped consent, crash recovery and synthetic verification. These are local implementations for review, not remote merge or release approval. The [integration report](../audit/secure-storage-collection-integration.md) records current functionality and remaining gates.
