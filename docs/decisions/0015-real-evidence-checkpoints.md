# ADR 0015: named checkpoints pin actual same-session evidence

17 November 2026. Implemented locally under the core functionality goal; Rasit retains final architecture/integration/merge authority. This is not a remote PR, deployment or release approval.

## Decision

Checkpoints name and retain actual captured file versions and recorded activity from one session. They do not capture process memory, unsaved documents, inferred application state or invented project references. The UI selects existing evidence; the engine rechecks every selected record and file BLOB before publication. Source labels identify files for the user and are never path authority. Native recovery still needs its own reviewed destination and explicit confirmation.

The engine validates unique IDs, session/time linkage, retained original-byte availability and metadata. Creation needs at least one selected record. Bounds are 100 file versions, 200 activities, 64 MiB of total original bytes and a 1 MiB projected metadata view. Original bytes are verified sequentially and wiped, not cached as checkpoint payloads. Storage admission reserves metadata headroom; failures return no claimed success. Browser article text is excluded from the checkpoint view: it has a separate permission/retrieval boundary. Actual visit metadata can be referenced, but this does not activate or claim working browser transport.

Migration 007 adds a real activity junction with foreign keys and same-session guards, and backfills historical browser-event membership. Existing migrations remain unchanged. Publication is transactional; absent/expired/wrong-session references fail without a partial manifest. The coordinator serializes evidence checks/publication with ingestion, retention and deletion. Startup checks membership guards, scope and Keep encoding as well as the existing encrypted database/FK/integrity checks. Missing guards or invalid metadata fail closed.

Keep protects the manifest and its selected file versions, shared original-byte blobs, activity records and FTS entries. Recent unkept manifests retain their references until the manifest itself expires or is evicted. Ordinary deletion/retention never silently drops kept evidence. Explicit deletion including Keep remains a separate user-confirmed storage action. Unkeep releases the protection; already expired evidence can disappear on the next cleanup. Deleting a checkpoint releases pins and removes the manifest, not original files or user-exported recovery copies.

Management supports bounded composite-time/UUID paging, source/session evidence selection, actual manifest inspection, escaped previews, separate-copy recovery, rename, Keep/Unkeep and confirmed manifest removal. Rename/Keep cannot alter the session, creation identity or evidence selection. A visible manifest periodically checks retained metadata and closes if deleted/expired/unavailable. Main-frame/location authorization, strict preload/reply schemas and the utility process remain the only UI capability boundary. No generic SQL/filesystem command is added.

## Alternatives, compatibility and limits

Retaining only names or unchecked watcher IDs would not preserve recoverable evidence. Copying original bytes per checkpoint would duplicate storage and complicate reference lifetime. Instead, immutable shared BLOBs are retained transitively through real version references. Cross-session aggregation remains outside the current checkpoint contract; callers select a session explicitly.

The synthetic plaintext repository adapter is not used by desktop production. Its tests now construct the current complete SQL fixture once, and reopen it without rerunning immutable upgrade SQL. Repository tests no longer rely on the historical missing browser-event FK to accept a dangling synthetic ID; they insert a real generated browser observation. Encryption tests still run through the actual keyed adapter, including restart, retained-byte verification and missing-guard refusal. No fallback or fixture data enters normal production composition.

This slice adds no dependency. Rich DOCX/PDF rendering, optional overwrite with durable preservation, browser registration/transport and conditional Gemini remain independent goal work. A saved checkpoint does not automatically reopen websites, launch programs, execute recovered markup or restore uncaptured state.

## Evidence and owners

Engine tests cover real manifest construction, immutable selection on rename/Unkeep, invalid/duplicate/missing/corrupt/future/cross-session evidence, browser metadata projection, quota/save failures and byte/metadata budgets. Encrypted storage tests cover activity/FTS retention across expiry and restart, Unkeep expiration, FK rollback, equal-time paging, deletion and missing-guard refusal. Packaged Windows tests capture actual generated file bytes, save a named version/activity checkpoint through the real UI, prove it survives ordinary history deletion and restart, inspect/preview its original bytes, then rename, Unkeep and confirm removal. Original generated files remain unchanged; ciphertext scans reject test content and checkpoint-name markers. See the [integration report](../audit/core-functionality-integration.md) for final command results.

Rasit owns engine/privacy/integration review, Mohammed Bashli storage/migrations/retention, Hacer React/preload integration and Abdullah selection/Keep/recovery UX review. Existing teammate branches and Git configuration are preserved.
