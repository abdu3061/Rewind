# ADR 0028: Retained evidence reviews and disclosure leases

Status: Implemented locally for Rasit's review. Desktop assistant composition remains in progress.

Owner: Rasit. Date: 18 November 2026.

## Context

The private SDK must receive actual approved evidence. A renderer-provided excerpt or reusable enabled flag cannot authorize transmission. Retention can expire during a model request, and checkpoint protection can keep an old observation available after its ordinary cutoff. Current exclusion policy and stored source identity must still govern every use.

## Decision

The engine prepares a local immutable review from one to twelve distinct actual activity IDs. It maps retained observations into bounded titles and excerpts and shows the exact proposed question and evidence before any cloud call. Browser queries/fragments and article text are omitted. File observations share names and observation facts only; stored paths never authorize file reads. Current application, website and folder exclusions apply, and composition supplies an additional private credential-disclosure denial.

Explicit confirmation selects only keys from that review. Claiming consumes the review and creates a private disclosure lease. Each verification rereads the actual sources and compares the resulting record against the approved snapshot. Missing, changed, malformed, excluded or expired evidence fails closed. Failed verification and observed permission/policy denial permanently end that lease. Re-enabling a boolean cannot revive it.

Reviews expire after at most five minutes on wall and monotonic clocks. The deadline is shortened to the earliest unkept source cutoff. Source protection comes from the encrypted store: an observation is protected indefinitely by a kept linked checkpoint; otherwise the retention anchor is the latest of its occurrence and linked checkpoint creation dates. Both current and legacy browser relation tables participate, matching maintenance. The millisecond boundary follows cleanup's strict less-than cutoff. Reverification can shorten authority after checkpoint protection changes and never extends it because the wall clock moved backward.

Actual maintenance mutations synchronously invalidate evidence authority inside the SQL transaction before commit. The callback is not invoked for read-only usage queries or no-op cleanup. If invalidation throws, the transaction rolls back. Compaction failures may still follow committed logical deletion, as already documented. Composition must connect this hook to review/model cancellation and invalidate before policy/checkpoint changes; these primitives alone do not enable cloud use.

## Alternatives and consequences

A fixed five-minute deadline alone could outlive near-expiry evidence. Testing only occurrence time would incorrectly reject actual checkpoint-protected evidence. Requerying immediately before a fetch alone would leave a later deletion interval. The selected approach combines authoritative source facts, bounded deadlines and synchronous mutation invalidation. It adds no schema, dependency, filesystem read or destructive model capability.

## Acceptance evidence

Engine tests cover actual IDs, immutable reviews, explicit subset confirmation, single use, privacy redaction/exclusions, private denial checks, retention protection, both clocks, source changes, permission/policy latching and delayed reads. Encrypted maintenance tests cover current browser identity, reopen, checkpoint anchors, the exact cutoff, pre-commit invalidation, rollback, no-op cleanup, explicit deletion and quota eviction. Full desktop permission/review/Search composition and packaged assistant tests remain required before ordinary cloud use is accepted.
