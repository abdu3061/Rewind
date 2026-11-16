# ADR 0008 — Bounded audit stabilization

Date: 16 November 2026. Status: Implemented locally for review; final integration approval remains with Rasit. Relevant owners: Mohammed Bashli (storage), Hacer Dilara (renderer), Mohammad Poorhamadi (collectors), Rasit (policy/integration).

## Context and decision

The [audit](../audit/README.md) reproduced existing failure-path defects. Correct those narrowly without introducing new capabilities, replacing the monorepo, selecting an encryption system, integrating pending PRs, or enabling capture/cloud features.

The baseline SQLite prototype now treats successful open as ready repositories, preserves an existing successful open, applies its existing SQL atomically and cleans failed initialization. An empty database without schema is an error; a previously initialized database may still open without a migration argument. Repository methods roll back only transactions they began. These are prototype integrity guarantees, not approval for real-data persistence or a new versioned migration system.

The renderer handles an absent preload capability as disconnected with disabled actions. Its existing import restriction also covers bare Node built-in names, closing a verified lint bypass. Main authorization remains unchanged.

On a separate descendant of the collector PR, restore default-off collection consent, use a typed nonautomatic PowerShell process variable, and reject persistent-open failure instead of successful volatile fallback. Retain the existing explicit `:memory:` prototype path for review; it is not an approved fallback for durable/encrypted mode. Isolate the native-failure test from the desktop. The patch does not approve the branch's remaining plaintext/main-process/lifecycle design.

## Alternatives, consequences and evidence

Leaving confirmed defects preserves false success and resource/data loss; rewriting the coordinator or introducing cipher/native/UI features exceeds this audit's approval. The chosen changes have focused before/after tests and are reversible through small local commits. Public capability contracts and dependencies remain unchanged; the stricter empty-schema error is an intentional failure correction with no current desktop consumer.

The [validation report](../audit/validation-report.md) records baseline and regression results; [findings](../audit/findings.md) preserve unresolved risks. The [architecture plan](../audit/architecture-improvement-plan.md) lists D1–D8 needing Rasit's approval. No merge, push or release follows from this ADR's local implementation status.
