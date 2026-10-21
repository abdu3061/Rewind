# ADR 0005 — Encryption-enabled storage gate

Date: 17 October 2026. Status: Encryption is required by the approved product scope; **binding/key/blob implementation is proposed and unselected**. Owner: Mohammed Bashli with Rasit's approval.

Use SQLite with FTS5 and encrypted immutable original-byte snapshots in version one. Define repository ports now without opening a database. Stock SQLite/`better-sqlite3` is not automatically encrypted; adding it now would falsely imply a storage solution before proving encryption and Electron packaging.

Evaluate an encryption-enabled SQLite build/binding (SQLCipher is one candidate), authenticated blob encryption, and OS-protected key access as one Windows packaged spike. Check exact Electron ABI/native rebuild/ASAR behavior, supported Windows architectures, FTS5 and migration/transaction support, WAL/temp/index coverage, wrong-key/tamper/restart behavior, binary supply chain, licenses, and maintenance cost. Use generated fixtures only until the sensitive-data path is approved and encrypted.

Do not fall back to plaintext when key/encryption setup fails. Store internal blob/key metadata outside public UI models. Rasit owns the security/key policy and snapshot/recovery orchestration; Mohammed owns database/storage implementation and tests. Neither selects a library solely because it builds under ordinary Node. [SQLCipher documentation](https://www.zetetic.net/sqlcipher/documentation/), [Forge native modules](https://www.electronforge.io/config/plugins/vite#native-node-modules)

Acceptance requires a real packaged Windows round-trip and failure tests, then an updated approved ADR before persistence of actual history. No encryption-enabled build, key vault, database, or binary content store exists in this starter.
