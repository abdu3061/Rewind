# ADR 0006 — Evidence and recovery contracts

Date: 17 October 2026. Status: Accepted initial contract direction; execution policy needs implementation review. Owner: Rasit, with all module owners as consumers.

Use UUIDs for public identities and ISO UTC millisecond timestamps for persistent time. Model normalized observation payloads, separate verified file identity from unverified titles, and reference evidence by typed source IDs. Keep database row IDs, blob paths, credentials, and keys out of public models. Use strict runtime schemas and structured Result errors at trust boundaries.

File versions link immutable captured content to file/session IDs and hashes; checkpoints select version/visit/project references and pin those artifacts when kept. Search answers need resolvable source references and explicit uncertainty; a file-change event does not establish foreground reading.

Recovery proposals are engine-owned, expiring, and confirmation-required. Save-copy is the default direction. Overwrite requires preserved current-version metadata plus implementation checks for successful byte preservation, integrity, scope, and concurrent changes. Models and renderers cannot grant authorization by setting a boolean. The assistant can propose a recovery but gets no execute/confirm tool; current IPC exposes no recovery method.

These contracts let UI, repositories and collectors develop against fixtures independently. Runtime schemas are necessary but cannot enforce cross-record existence, OS path safety, reference pinning, proposal single-use, or actual successful preservation; those checks belong in the engine/storage workflows and integration tests. See [contract details](../contracts.md).
