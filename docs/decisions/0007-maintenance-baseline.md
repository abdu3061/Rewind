# ADR 0007 — Maintenance baseline

Date: 16 November 2026. Status: Implemented locally; pending Rasit's review. Owner: Rasit.

## Context

The branch review found UI simulations, automatic collection consent, and plaintext persistence in pending work. A passing CI run does not establish compliance with the approved collection and encryption gates. The existing baseline also contained unused scaffold files and UI preview remnants.

The installed Electron 44.9.0 is affected by [GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9). The advisory concerns TLS connections using compromised intermediate certificates; the starter does not intentionally make external network requests.

## Decision and alternatives

Keep the synchronous in-memory session service and existing validated bridge. Leave incomplete branches open rather than enabling their runtime integrations. Remove unused root scaffold entry points and ordinary-use synthetic history; retain the workspace app and honest unavailable states.

Update Electron to 44.11.3 within the existing major version, preserving the Forge/Vite stack and lockfile. Leaving the affected version installed carries a known dependency advisory; a major runtime/tooling migration would broaden this maintenance task unnecessarily. This patch adds no new package or feature and grants no collection, persistence, cloud, or recovery capability.

## Consequences and acceptance

Collection stays off, sessions reset on exit, and stock SQLite remains an unconnected prototype for synthetic tests. A later persistence or collector integration still needs the existing architecture, consent, utility-process, encryption, and failure-test gates.

Validation requires `npm ci`, `npm run check`, `npm run build`, and `npm run test:app` against the patched runtime. Actual results and remaining audit findings are recorded in [repository status](../repository-status.md). Final review and any shared-main update remain Rasit's responsibility.
