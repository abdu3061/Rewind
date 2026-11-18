# ADR 0027: private Gemini credential storage and sealed native entry

18 November 2026. Private primitives implemented locally for Rasit's security/recovery/dependency review. Normal desktop connect/permission/Search composition remains unfinished and cloud use stays unavailable. No live provider credential or request is used in verification.

## Decision

Keep API keys out of React, preload, main-process plaintext, PowerShell variables, logs, arguments and extension storage. Store the configured key only in the existing encrypted SQLite database, whose key already uses Windows protection. A key does not grant cloud approval. No generic credential, filesystem, execution or plaintext-key IPC capability is exposed.

Migration 009 adds a single bounded operational credential row, revision and update time. It contains no cloud grant, capture evidence or FTS entry. The utility repository validates reads, uses revision-checked owned transactions and confirms readback before commit. Errors are sanitized. Stale/failed writes do not report success; a caller's transaction is never taken over. Missing/malformed credential state fails secure startup rather than silently recreating or erasing it. Earlier migrations/checksums remain unchanged.

Ordinary history expiration/deletion preserves this operational configuration. A separately confirmed credential removal sets it to null after cloud revocation/drain. Removal is not a provider-key revocation or a forensic-erasure promise. Future UI must distinguish forgetting the local key from deleting work history, and must never call a merely configured key a validated provider connection.

## Native entry and channel

The utility issues a fresh ephemeral RSA-4096 recipient and a two-minute, single-use challenge after cloud quiescence. Main receives only the public modulus/exponent, UUID and expiry. The native Windows credential helper uses a generic non-Windows credential dialog, fixed username and no Windows Credential Manager persistence, bound to the main-owned window/process. It accepts bounded ASCII provider keys up to the native password-buffer limit of 256 characters. Main's owner comes from its own Electron window, never renderer input.

The key stays in the native password buffer. C# validates characters and seals a bounded `{id,apiKey}` message directly to the utility public key with the platform RSA OAEP-SHA256 implementation. It does not create a plaintext key string in PowerShell or return one to main. Native password/plaintext byte buffers are cleared. Main receives only a bounded sealed packet, which remains private and is not a preload response. The utility consumes the challenge before decrypting, checks the embedded UUID, format, both expiry clocks and current operation epoch, revokes/drains cloud work again, then revision-checks persistence. Decrypted byte buffers are cleared before asynchronous work. JavaScript/native cryptographic memory is not claimed to be forensically erased.

This sealing is data minimization between trusted composition layers, not a replacement for IPC authorization. Possessing a public key does not authorize configuring credentials. Future main/worker routing must keep preparation/acceptance private, require the public user's explicit configuration action and native confirmation, cancel outstanding challenges on denial/shutdown, and return only configured/off/error status. Cloud opt-in and question/evidence approval remain separate. Restart/cancellation invalidates ephemeral recipients; no private RSA key is persisted.

The helper uses only static trusted code and public metadata, has strict input/output bounds, validates its owner before prompting and loads native DLLs only from System32. Main tracks its exact child, applies the challenge deadline and observes exit on shutdown; unknown closure is a retryable error. Utility shutdown similarly retains outstanding recipient generation/work until observed. No source title/path or API key enters process arguments or operational diagnostics.

## Verification and remaining work

Storage tests cover live database/WAL confidentiality, private reopen, no FTS/permission grant, retention/history deletion, separate removal, stale/invalid/concurrent writes, SQL rollback, caller transactions, missing/malformed/oversized state, wrong keys and preserving schema-8 upgrades. The older browser setup upgrade fixture remains pinned to schema 7 so its original migration coverage is retained.

Recipient tests exercise actual RSA encryption, immutable public replies, single use, confirmation/cancellation, both clocks, invalid/cross-recipient data, stale revisions, quiescence, thrown persistence errors, explicit forgetting and late-generation shutdown retry. Native tests compile the actual C# helper, verify CNG-to-Node OAEP interoperability and the complete synthetic native-buffer → utility recipient → actual encrypted store path, reject an invalid owner and observe helper shutdown. Test wrappers insert only known synthetic keys; no production test-injection mode or plaintext capability is added.

The interactive credential dialog has **not** been exercised with a real user credential or claimed as visually verified. Before enabling the normal workflow, finish main/worker orchestration, configured status, explicit cloud permission, engine-issued evidence reviews, per-question approval and Search UI; verify the packaged path with marked synthetic fixtures/provider responses. A live provider call remains separately unverified. Core recording/recovery stays usable with cloud off.

Reference: [Windows generic credential prompt and non-persistence flags](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creduipromptforcredentialsw).
