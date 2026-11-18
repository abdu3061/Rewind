# ADR 0029: Utility assistant consent and credential composition

Status: Implemented locally for Rasit's review. Main/native dialog routing, public preload/UI and packaged assistant verification remain in progress.

Owner: Rasit. Date: 19 November 2026.

## Context

The official SDK, encrypted credentials and engine disclosure leases need a common lifecycle. A saved key must not enable cloud use, an old grant must not survive a worker restart, and cancellation must not allow a second SDK instance while an earlier transport is still running.

## Decision

`AssistantOperations` lives in desktop utility composition. It reads the operational credential only from the keyed store, creates engine reviews from actual encrypted history through the serialized coordinator queue, and invokes the official SDK only after separate launch approval and per-question selected-key confirmation. Browser evidence remains redacted metadata and file observations remain name-only. The provider has no recovery, deletion, arbitrary history query or filesystem tool.

Private worker credential commands carry public RSA challenge or sealed bytes only. Configuring/replacing/forgetting a key first denies and drains cloud use. Configuring never grants approval. The ordinary renderer command schema rejects these private credential commands; the native main-owned orchestration and public controls are a separate remaining integration step.

Cloud permission updates use the same coordinator settings boundary as recording preferences. An active recording session pauses when settings change and requires explicit resume. Denial takes effect synchronously, before writes or draining. A revision check fences stale changes, and an older failed operation cannot cancel a newer denial. Startup forces cloud permission off even if the previous settings record was enabled. Kept history and ended sessions can be selected; an active capture session is not required to analyze retained evidence.

Privacy, folder, browser setup, checkpoint and explicit storage mutations synchronously revoke assistant authority before running. Actual automatic cleanup/quota mutations use ADR 0028's pre-commit invalidation hook. A changed or removed source cannot be used by an existing review, model fetch or answer publication. Replies include an authorization revision; answers also carry a bounded display expiry for the forthcoming UI.

One SDK request runs at a time. Cancellation invalidates leases and aborts transport immediately, while the SDK retains actual unfinished work. A replacement model is created only after observed closure. Shutdown closes credentials and SDK work before closing storage, and failed closure remains retryable. A completed worker shutdown is idempotent. The main supervisor allows forty seconds for the bounded thirty-second model request and reserves denial/stop/forget/cancel behavior under queue saturation.

The desktop declares its existing assistant workspace dependency. There is no new third-party package or model endpoint, and no configurable transport in the worker bootstrap or renderer protocol. A direct in-process transport injection is available only to synthetic tests.

## Acceptance evidence and limits

Five tests compose the actual worker, coordinator, engine review, encrypted SQLite repositories, ephemeral RSA credential recipient and official SDK with synthetic HTTP responses. They verify selected actual-source citations, no request before both approvals, unselected evidence/private-ID/key omission, restart denial, concurrent denial priority, deletion while transport ignores abort, refusal to replace unfinished work, exclusions, sealed key replacement, replay refusal and separate confirmed forgetting without deleting history. Supervisor tests cover model deadlines and saturated denial/stop/forget controls.

These tests never use personal activity, actual browser history, live API keys or real provider requests. A real Gemini account request, interactive positive native credential entry and the normal packaged Search workflow are not yet verified. This ADR does not claim the assistant is available in the ordinary app.

The SDK additionally refuses decoded provider answer text containing the configured credential, including JSON-escaped input. Final validation passes the full check (470 tests / 56 files), Windows build, 16 rebuilt packaged tests and 6 installed-browser tests. SDK implementation code is present only in the generated utility bundle.
