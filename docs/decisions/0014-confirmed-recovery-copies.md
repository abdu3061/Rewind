# ADR 0014: confirmed original-byte recovery copies

Follow-up: [ADR 0024](0024-confirmed-overwrite-preservation.md) now implements the separate optional overwrite workflow. The copy-only behavior and original evidence below retain their historical scope.

17 November 2026. Implemented locally under the core functionality goal, pending Rasit's final technical review. No remote merge, publication, installer or release approval is implied.

## Decision and ownership

Engine-owned recovery copies use retained, hash-verified original bytes. Main owns the native destination dialog. The public capability accepts a version ID, then a single-use proposal ID plus literal confirmation; the renderer cannot supply a path or raw bytes. Utility composition validates policy and native directory identity. Rasit owns engine/safety semantics, Hacer and Abdullah review the UI, and Mohammed Bashli reviews encrypted source retention behavior.

The engine holds at most eight five-minute proposals and one active preparation/write. Proposals contain metadata and directory proof, never cached snapshot bytes. A proposal expires on either wall or monotonic time; confirmation rechecks expiry after source verification. Cancel, expiry, reuse and service restart invalidate authority. Confirmation consumes authority before asynchronous work. Source deletion/expiration/integrity failure aborts before writing. Returned proposal objects cannot mutate the internal plan.

The existing Windows handle adapter validates local fixed NTFS destinations, bounded paths, ancestor identities, case sensitivity and reparse points. The write adapter reacquires those guards and compares the selected parent identity at use. A static C# helper uses `CREATE_NEW` with exclusive sharing, read/write/delete access and write-through. Existing files, links or racing creations are rejected. The destination is never opened with an overwrite/truncate disposition. It hashes input before creation, flushes the complete bytes, reads back through the same exclusive handle, checks hash/length/file identity and reports success only after verified closure. The result is an export receipt, not a fabricated persisted/captured file ID.

On failure after creation, cleanup targets the newly created **handle** with `FileDispositionInfo`, not a path that could have been replaced. A helper crash, timeout, power loss or failed cleanup can leave a partial new file. The app reports uncertainty and directs the user to inspect the destination; it never calls this an atomic filesystem/database transaction. A previous unobserved helper prevents another native write. Shutdown invalidates proposals, kills/observes native helpers and drains pending work before database close; failed helper termination remains visible and retryable.

User-selected copies are ordinary files outside encrypted history. They are not automatically protected/encrypted by Rewind and are not removed by history deletion or retention. Their contents may contain active document formats; Rewind does not open or execute them. UTF-8 previews remain escaped, and rendering unsupported formats is not fabricated. Synthetic verification confines writes to its marked profile.

## Alternatives and remaining work

Path-based Node writes or close-and-replace after a safety copy would introduce identity/race windows. They are not used for this copy workflow. Optional overwrite remains a separate required milestone: it needs durable verified preservation, current-state comparison, crash/failure behavior and a proven Windows commit strategy. The copy implementation does not approve a truncate/write fallback or claim overwrite support. AI has no confirmation/execution tool.

No dependencies are added. The existing PowerShell/C# Windows adapter is extended with a private one-shot helper. Bundled static source enters the pipe first; selected paths and bounded original bytes are later JSON data. Changing console encoding after the first read discarded buffered command data in an initial test; the helper preserves the bootstrap reader. Paths/content never enter process arguments, diagnostic logs or temporary script files. Maximum-size original bytes traverse bounded private stdin; only bounded verification metadata returns.

## Acceptance evidence

Native tests verify exact binary/16 MiB copies, existing-file preservation, invalid hashes, traversal, replaced directories and junction rejection. Engine tests verify explicit/single-use/immutable proposals, expiry, deletion/corruption, late verification, output mismatches, failed writes, shutdown drain and failed-close retry. Worker tests use real encrypted captured bytes and actual native copies, including deletion between review and confirmation. Packaged tests use the real UI/preload/utility/native writer with only a synthetic destination-dialog choice: cancel creates nothing, confirmation restores earlier bytes, current contents remain intact, existing destinations fail, and captures remain available after restart. Exact completed command results are recorded in the [integration report](../audit/core-functionality-integration.md).

References: [CreateFileW dispositions and sharing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle), [file information classes](https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ne-minwinbase-file_info_by_handle_class).
