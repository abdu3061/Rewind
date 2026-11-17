# ADR 0010 — Encrypted metadata and Windows-protected keys

17 November 2026. Owner: Rasit, with Mohammed Bashli's storage ownership preserved. Status: implemented locally under the authorized secure-storage/collection goal; final integration review remains required. No release or remote merge approval is implied.

## Selection and evidence

Keep SQLite and the existing repositories. Use pinned `better-sqlite3-multiple-ciphers` **13.1.1**, its Node-API Windows x64 prebuild, SQLite **3.54.1** and SQLite3 Multiple Ciphers **2.7.0**. Its [release](https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/tag/v13.1.1) lists Node 22+ and Electron 35+ support. An actual Electron **44.11.3** / embedded Node **24.22.2** utility-process probe loaded the addon and verified encrypted reopen, wrong-key rejection, FTS5 and absence of synthetic marker text from database/WAL bytes. Shell tests use Node **22.16.0**. Actual application packaging is a separate mandatory integration check.

The [2.7.0 cipher release](https://github.com/utelle/SQLite3MultipleCiphers/releases/tag/v2.7.0) fixes key-setup paths that could silently produce unencrypted databases. Do not downgrade to older prebuilds to work around Electron packaging. JourneyApps' currently documented platform support excludes Windows; ABI-specific older forks/prebuilds do not provide better evidence for this runtime. This is the SQLite3 Multiple Ciphers SQLCipher-compatible profile, not a claim of using Zetetic's distribution, certification or full external-tool interoperability.

## Format and startup

Clean-install follow-up: plain `npm ci` initially synthesized `node-gyp rebuild` because npm's lock metadata omitted the upstream `gypfile: false` flag. Preserving that exact manifest flag in the pinned lock entry makes plain `npm ci` succeed without compiling the addon. `scripts/prepare-native-lock.mjs` maintains this narrow metadata correction after lock regeneration, and `check:install` detects its loss. No global npm settings, dependency archive, native binary or cryptographic code is patched. The clean install, packaged build and runtime checks must remain acceptance evidence on upgrades.

Format one uses SQLCipher legacy profile 4, HMAC enabled with SHA-512, PBKDF2-HMAC-SHA-512 at 256,000 iterations and no plaintext header. A generated 32-byte random secret is passed through the driver's binary key API; no SQL string contains a key. The adapter verifies the active parameters and exact codec build. It keys an existing connection before any prepared statement, authenticates the schema, applies checked migrations, validates required columns/index triggers and checks database integrity. Failure closes the handle and exposes no repositories. Plain SQLite headers, unknown schemas, changed migration checksums, future versions and wrong/missing keys fail closed. No plaintext conversion, memory adapter, automatic rekey or key regeneration for existing history is allowed.

Migration SQL remains authoritative in `db/migrations`, bundled as Vite raw source with ordered numeric versions and SHA-256 checksums. Each upgrade and its version records share one owned transaction. Existing repository semantics and rollback ownership are retained through a minimal database connection type; the legacy stock-SQLite adapter remains only a synthetic prototype.

WAL and FULL synchronization are enabled. SQLite3 Multiple Ciphers encrypts pager/journal content; synthetic tests inspect live WAL bytes and index content as well as the database. Temporary SQL storage is forced to MEMORY before use, secure-delete is enabled, and native extensions are not exposed. A database page cap bounds metadata; it is not a claim that all future blob/kept-data quotas are implemented. No document/snapshot bytes are introduced in this goal.

## Key boundary

The main process alone calls Electron's asynchronous [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) API after app readiness, only on Windows with protection available. Windows uses DPAPI. Infrastructure receives a protector port and never imports Electron. Only protected key bytes are written, using an exclusive temporary file, fsync and atomic non-overwriting hard-link publication. Reopening requires the same protected key. Corrupt/unavailable key blobs and missing keys beside existing databases are preserved and reported as failures.

The private directory and files reject symlinks/junctions. Keys never enter renderer/preload, logs, environment variables or argv. Main passes a short-lived key copy only to its owned utility process over the private message channel; byte buffers are wiped when their owner finishes. JavaScript strings/native memory are not a forensic-erasure guarantee.

DPAPI protects against other logon users; it does **not** protect a running process or key from malware/debuggers acting as the same Windows user. This is stated by Electron's documentation. Full-disk/pagefile/backup protection, signing, key rotation/loss UX and clean-machine/native supply-chain review remain release concerns. No shared embedded key or Linux `basic_text` fallback is accepted.

## Verification and consequences

Node tests cover ciphertext/WAL/FTS, persisted settings/events, wrong/missing keys, tampering, malformed/future migration metadata, failed migration rollback, scoped composite queries and concurrent/protected key creation/failure. Windows DPAPI and the actual utility runtime are exercised separately using synthetic data. See the consolidated implementation report for final package evidence and milestone limits.

No existing plaintext personal history is imported or overwritten. The app uses a distinct secure directory. If historical data needs migration, preserve it and design an explicit verified import rather than treating it as this format. Cipher/native upgrades require review and re-running the complete packaged reopen/failure matrix before adoption.
