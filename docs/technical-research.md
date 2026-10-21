# Rewind: technical research and implementation recommendation

Researched 17 October 2026. The repository contained only Git metadata when inspected. This document proposes an architecture; no application has been implemented or benchmarked. The research includes official platform documentation, repository metadata and licenses, and targeted source inspection. It is not a complete audit of the listed projects.

Windows first is a working assumption pending a platform decision. Cross-platform UI code does not make activity collection cross-platform: each OS and supported application needs its own capability checks and testing.

**Recommendation.** Build a local-first desktop app with three independent capabilities: a structured activity timeline, a temporary file-version store, and an assistant that searches those records. Use Electron, React, TypeScript, SQLite/FTS5, a Chrome/Edge extension, and narrow native capture dependencies for the first implementation. Use Gemini through the official JavaScript SDK for optional cloud reasoning. Keep the capture and recovery engines operational without a model or internet connection. Defer cloud synchronization until the local retention and recovery behavior is proven.

The central engineering challenge is reliable evidence collection and safe file recovery. AI is the query and explanation layer. It cannot reconstruct missing document contents or infer an exact file path from an ambiguous title with certainty.

**What the initial promises can support.** Define support by integration and show the evidence available for each result.

| User request | Evidence needed | Initial support boundary |
| --- | --- | --- |
| Find a website about machine learning | URL/title, visit interval, and preferably permitted page text | Chrome/Edge extension; title-only results have limited subject recall |
| Find the PDF before VS Code | Ordered focus events and a verified PDF resource identity | PDFs opened through Rewind, or a specifically tested viewer integration; otherwise show candidates |
| Explain work around 2 PM | Focus intervals, browser visits, idle/lock gaps, file events | Describe observed activity and cite times; do not equate a background file write with user attention |
| Recover a previous Word version | An earlier complete byte snapshot | Supported files inside opted-in folders, from the time protection became active |
| Resume a checkpoint | A manifest of resources and saved file-version references | Reopen selected URLs/files/project folders; unsaved buffers and process memory require application-specific support |

File access, file modification, and foreground document activity are separate observations. A folder watcher is useful for changes, but does not establish that the user opened or read a file. The NTFS USN journal records change facts and explicitly lacks enough information to reverse those changes. [Microsoft: change journal records](https://learn.microsoft.com/en-us/windows/win32/fileio/change-journal-records)

**Stack selection.** These choices prioritize delivery speed for a small team without an established Rust requirement. The expected resource and development tradeoffs below are engineering judgments, not benchmark results.

| Layer | Initial choice | Reason and boundary |
| --- | --- | --- |
| Desktop shell | Electron with React, TypeScript, Vite, Electron Forge | Shared TypeScript across UI, extension, and core logic; validate installer size and background memory early |
| Background work | Electron utility process for collection/storage; bounded parsing jobs | UI closure must not stop an active session; parser failures should not stop capture |
| Foreground apps | `get-windows` initially; optional Windows event-hook helper after measurement | App/process/window metadata; no universal document identity |
| Browser | Manifest V3 Chrome/Edge extension | Active tab URL/title and focus; page text only with separate, explicit site permissions |
| Folder changes | `@parcel/watcher` plus an application-owned snapshot queue | Notifications trigger capture; deduplicate, stabilize reads, and reconcile missed events |
| Metadata/search | SQLite + FTS5; `better-sqlite3` in a background process | Time queries, relationships, keyword search, transactions; package native modules for the exact Electron runtime |
| Temporary versions | Immutable full-file blobs indexed by content hash, plus version metadata | Straightforward for a bounded selection of small documents; large files need a different storage policy |
| Content extraction | Mozilla Readability, PDF.js, Mammoth raw-text extraction | Useful searchable text; extracted text is a derivative, while recovery preserves original bytes |
| AI | Official `@google/genai` SDK and a bounded tool loop | Start with one assistant; choose a stable model after recall/latency/cost evaluation |
| Semantic retrieval | Add embeddings and `sqlite-vec` after a keyword baseline | Improves paraphrase recall; does not solve absent content |
| Release security | OS-protected credentials/keys, encrypted blobs, encrypted SQLite build | Stock SQLite/`better-sqlite3` does not provide database encryption automatically |

Electron provides a Node-capable utility-process API suitable for background components. Keep filesystem APIs and credentials behind narrowly scoped IPC, enable renderer isolation/sandboxing, and display captured content as untrusted data. [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

**When to choose a different shell.** Tauri 2 + React + Rust is the strongest alternative when the team knows Rust and background resource use is a primary constraint. Its OS-provided WebViews reduce bundled application size, while introducing rendering differences between platforms. Use Rust `notify`, SQLite bindings, and OS adapters in that version; call Gemini over HTTPS rather than introducing Node and Python solely for AI. Measure runtime memory rather than assuming a particular saving. [Tauri process model](https://v2.tauri.app/concept/process-model/), [notify](https://github.com/notify-rs/notify)

A permanently Windows-only product with a C# team could instead use .NET with WPF/WinUI, or a WebView2 shell. That simplifies access to Win32/COM at the cost of a different portability path. For the proposed Electron MVP, introduce a small native helper only when a proven capture or browser-bridge requirement needs it; do not start with several backend languages.

**Collection design.** Keep collectors behind a shared event contract so they can be replaced independently.

1. A desktop collector emits foreground-app intervals, title changes, idle/lock transitions, and capture gaps. A one-second polling prototype is acceptable for validation, with its resolution disclosed. Windows event hooks are a later option for more precise focus transitions and require proper message-loop handling. [SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)
2. The browser extension emits navigation, activation, focus, and visit duration. An active tab can exist in an unfocused window, so correlate tab activity with browser-window focus. The `tabs` permission grants sensitive title/URL access; `activeTab` alone only grants temporary access after a user gesture. [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
3. For permitted sites, capture readable text from the loaded page at visit time. Keep a versioned content artifact linked to the visit: fetching the URL later can return different content. Run Readability on a cloned DOM, store plain text, and record extraction failures. Articles work better than arbitrary web apps; internal browser pages, built-in PDF viewers, restricted frames, and protected content need explicit support decisions. [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [Readability](https://github.com/mozilla/readability)
4. Prefer Native Messaging for the shipping browser bridge. Register allowed extension origins and pass structured messages through a small bridge into the collector. A prototype loopback endpoint needs pairing/authentication, origin checks, request limits, and strict validation. Extension queues and logs also need session stop/delete behavior. [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
5. Track exact file identities through Rewind's own Open action or supported application adapters. A future VS Code extension can supply editor paths. Word exposes a document's full name through its object model, but that is an integration to test, not a property of generic window tracking. [Word Document.FullName](https://learn.microsoft.com/en-us/office/vba/api/word.document.fullname)
6. Watch only folders the user selected. Subscribe before taking an initial baseline, reconcile concurrent events, then capture stable changed files. Record whether baseline protection is complete before claiming an item is protected.

Use explicit evidence labels such as `verified-path`, `title-match`, `file-change`, and `integration-unavailable`. Preserve collector version, timestamps, source, and resource IDs. Store UTC timestamps with session time-zone context and a local ordering sequence; handle sleep/wake, clock changes, and reconnects. Never silently fill a capture gap with the previous activity.

**Versioning and recovery.** An initial snapshot preserves the starting contents. Later successful snapshots preserve subsequent observed states. A change notification arrives after a change and cannot retrieve overwritten bytes that were never saved. Ordinary folder watching also cannot promise every rapid intermediate save or coherent snapshots of live databases and multi-file applications.

Treat watcher events as prompts to inspect state. Windows notification buffers can overflow and require directory enumeration. `@parcel/watcher` also coalesces events and represents renames as delete/create pairs, so its events are not a lossless audit log. Add reconciliation on startup/wake, on watcher errors, and periodically. Preserve both original path and a file identity where available, while recognizing that applications may replace a file during save. [ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw), [@parcel/watcher](https://github.com/parcel-bundler/watcher)

Proposed initial policy: text/code, `.docx`, and `.pdf` in selected folders; a configurable per-file size limit; exclusions for build trees, credentials, caches, temporary lock files, and online-only placeholders. Capture encrypted immutable byte blobs after reads settle, retry transient locks, detect a file changing during capture, and mark failures visibly. Preserve full bytes for recovery; a text diff of a Word document does not preserve its formatting. Legacy `.doc`, encrypted documents, live databases, and unsaved editor state should have explicit unsupported or limited-support statuses.

Mammoth can extract raw `.docx` text, but its output is not a faithful document renderer. Use PDF.js for supported PDF previews/text extraction; image-only PDFs need an optional OCR path later. Sandboxed or separately isolated parsing, size/time limits, and plain-text rendering should precede rich HTML previews. [Mammoth](https://github.com/mwilliamson/mammoth.js), [PDF.js](https://github.com/mozilla/pdf.js)

The restore flow should be deterministic and owned by the application:

1. Identify an exact file-version ID and verify its stored content hash.
2. Show source time, destination, and a preview/diff; offer **Save recovered copy** as the default.
3. Require an explicit UI confirmation for the concrete restore or overwrite plan. Bind approval to version ID, destination, and expected current-file identity/hash.
4. For an overwrite, successfully preserve the current contents first; abort if that safety copy fails. Require supported documents to be closed when necessary and refuse a changed or locked destination.
5. Write and verify a temporary sibling, then use a tested Windows replacement operation. A failed atomic replacement must not silently fall back to truncating the original file.
6. Verify the final result and record the recovery event. Test interruption and conflict cases, including another application saving the file.

A checkpoint is a manifest of selected file-version IDs, resource URLs, project roots, optional supported application state, and capture outcomes. Capture its files when requested and show partial failures; do not merely label an existing stale version as current. Pin only the exact retained artifacts and the minimal related context. A group of sequential file copies is not automatically a transaction-consistent workspace image.

**Search and AI.** Begin with indexed time/resource queries and SQLite FTS5, which provides keyword search and ranking. Add semantic retrieval for paraphrases, with time/app/type filters applied before or during ranking and events linked back to their content revisions. `sqlite-vec` is a reasonable local candidate, but its current README warns that it is pre-v1; pin it and test schema migrations. Local embeddings avoid sending the whole corpus to an embedding API. [SQLite FTS5](https://sqlite.org/fts5.html), [sqlite-vec](https://github.com/asg017/sqlite-vec)

The assistant should call typed functions such as `search_events`, `get_timeline`, `get_resource`, `list_file_versions`, and `prepare_restore`. Application code validates parameters and runs parameterized queries. Give the assistant read access and proposal tools; the UI and recovery service enforce confirmation for writes. Treat captured pages and documents as evidence, never as instructions that grant tool permissions.

For “What PDF before VS Code?”, identify the relevant VS Code focus transition, find the preceding verified PDF activity, and explain any ambiguity. For “What around 2 PM?”, select the requested day's interval in the session's time zone. For topic recall, combine matching content with evidence that the user visited that resource. Every substantive historical answer should include timestamps, a source link, and a route to the underlying event. Return an honest insufficient-evidence result when needed.

Google ADK is optional. The Gemini API already supports function calling, and the official SDK supports TypeScript. ADK also has an official TypeScript implementation, so it does not require introducing Python. Add it if its orchestration/evaluation features help a concrete workflow; do not make collection, retention, or restore correctness dependent on it. Pin SDK and model versions after evaluation. [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling), [Google Gen AI SDK](https://github.com/googleapis/js-genai), [ADK TypeScript](https://github.com/google/adk-js)

**Local storage, cloud, and expiration.** Store timeline metadata, resources, visits, content revisions, file versions, checkpoints, checkpoint membership, and restore plans in SQLite. Keep potentially large immutable file blobs separately. Garbage-collect blobs only after all unexpired and pinned references are gone. Deduplication is an optimization, not encryption or a retention policy.

Suggested starting defaults, to validate with users: explicit session start, a visible capture/pause indicator, 72-hour temporary retention, a configurable disk quota, and explicit pinning. Pause must stop collection; ending a session and immediately deleting it should be separate visible actions. Apply exclusions before persistence, including to generic desktop window titles. Skip private browser contexts, sensitive sites/apps, and form inputs; preserve only URL components needed for useful recall without retaining credentials or sensitive tokens.

Encrypt release data at rest, including metadata and derived content, with an audited database/blob approach and OS-protected keys. SQLCipher is an established SQLite encryption option, but a compatible Electron binding/build is an implementation gate. Encryption at rest does not prevent a compromised logged-in session from accessing unlocked data. [SQLCipher](https://www.zetetic.net/sqlcipher/)

Expiration must cover events, FTS/vector entries, extracted text, summaries, chat context, preview/temp files, diagnostic logs, extension buffers, blob references, and any cloud copies. SQLite WAL and auxiliary structures need deliberate maintenance; an SQL delete alone is not a forensic-erasure guarantee. Do not promise physical secure erasure from SSDs or unrelated OS backups. [SQLite secure_delete](https://sqlite.org/pragma.html#pragma_secure_delete), [SQLite WAL](https://sqlite.org/wal.html)

Cloud inference and cloud storage are separate settings. For cloud inference, send only the selected question and necessary retrieved evidence. Never embed a shared production provider secret in a distributed desktop app: use a user-provided key protected by the OS for a prototype, or an authenticated metered service for a product. If strict local-only AI is needed, a later local runtime is possible, but model quality, model licensing, hardware, memory, and downloads need separate evaluation.

Gemini's current terms distinguish paid and unpaid data handling. The unpaid service can use submitted content for product improvement and human review, with regional exceptions; paid-service prompts/responses are not used to improve products, but may still be logged temporarily. Rewind's local expiration cannot delete a provider's separate logs. Choose an appropriate paid configuration before handling real session content, and explain that boundary in the product. [Gemini API terms](https://ai.google.dev/gemini-api/terms)

**Repositories worth using or studying.** The licenses below were checked against the current repositories on the research date. Pin exact revisions and review dependency licenses before incorporating code. A public repository is not automatically permissively reusable.

| Repository | Role for Rewind | License / decision |
| --- | --- | --- |
| [ActivityWatch](https://github.com/ActivityWatch/activitywatch) | Best overall reference for structured watchers, heartbeats, app/browser intervals, and a local query API | MPL-2.0; prototype against its API, or reuse selected components rather than adopting its whole product |
| [aw-watcher-web](https://github.com/ActivityWatch/aw-watcher-web) | Strong browser-extension starting point; current implementation uses TypeScript and supports Chrome MV3 | MPL-2.0; adapt consent, filtering, transport, lifecycle, and optional content capture |
| [get-windows](https://github.com/sindresorhus/get-windows) | Direct Node dependency for foreground-window metadata | MIT; Windows URL capture is not provided; its URL field is macOS-only and Wayland is unsupported |
| [@parcel/watcher](https://github.com/parcel-bundler/watcher) | Direct Node dependency for native recursive filesystem notifications | MIT; implement version capture and reconciliation around it |
| [restic](https://github.com/restic/restic) | Established encrypted/deduplicated backup CLI; candidate for broader scheduled/manual workspace checkpoints | BSD-2-Clause; prefer a CLI boundary and stage restored files before application-controlled replacement |
| [Kopia](https://github.com/kopia/kopia) | Alternative encrypted snapshot engine, including local/cloud storage | Apache-2.0; evaluate against restic, then choose one if broader backup becomes necessary |
| [ZFileTimeMachine](https://github.com/TheHolyOneZ/ZFileTimeMachine) | Closest recovery UX/architecture example: folder watching, versions, diff, retention, and content-addressed blobs | GPL-3.0; young project, inspect as a reference; incorporating code needs a compatible distribution plan |
| [OpenRecall](https://github.com/openrecall/openrecall) | Example of local recall and semantic search | AGPL-3.0; screenshot-based design is outside the proposed MVP's capture scope |
| [Screenpipe](https://github.com/screenpipe/screenpipe) | Study the product experience and system boundaries | Current custom commercial license requires separate permission for commercial use and prohibits competing-product use without it; do not copy/integrate under an assumed MIT license |

ActivityWatch's main repository is a bundle of components, not a single drop-in TypeScript backend. A prototype importing its data must also control the originating ActivityWatch store's lifecycle; deleting only Rewind's imported copy would leave another history behind. Modifications to distributed MPL-covered files carry source-availability obligations, while separate new files can use another license. [ActivityWatch architecture](https://github.com/ActivityWatch/activitywatch), [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)

Targeted inspection of [aw-watcher-web heartbeat code](https://github.com/ActivityWatch/aw-watcher-web/blob/da389c055584b6d60ce2baf8bb4cc270079faebf/src/background/heartbeat.ts) confirmed tab metadata and serialized heartbeat updates, not readable article content. Its [manifest](https://github.com/ActivityWatch/aw-watcher-web/blob/da389c055584b6d60ce2baf8bb4cc270079faebf/src/manifest.json) also demonstrates why extension permissions and capture behavior need review when adapting an existing collector.

ZFileTimeMachine was created in June 2026; its latest GitHub release checked was [v0.2.0](https://github.com/TheHolyOneZ/ZFileTimeMachine/releases/tag/v0.2.0), published 14 October 2026. It is a useful reference, not evidence of production reliability. At inspected revision `5812e713692664f5226cc231f05deb28ad2a7b6a`, the [rewind implementation](https://github.com/TheHolyOneZ/ZFileTimeMachine/blob/5812e713692664f5226cc231f05deb28ad2a7b6a/src-tauri/src/commands/rewind.rs) can continue after a pre-rewind snapshot error because its result is collapsed to `None`. Any adaptation should enforce a successful safety copy before overwrite. This finding comes from a narrow source review, not a runtime reproduction.

Restic and Kopia solve backup storage, not user-attention capture or document-open attribution. Avoid launching a full-folder backup for every watcher event. Start with one bounded document-version store; add one of these engines only if large workspaces/cloud backup justify its orchestration and maintenance costs. Restic's `forget` removes snapshot references, while `prune` removes now-unreferenced stored data; its default in-place restore can overwrite files, so Rewind needs its own preview and confirmation boundary. [Restic expiration](https://restic.readthedocs.io/en/stable/060_forget.html), [Restic restore](https://restic.readthedocs.io/en/stable/050_restore.html)

Screenpipe's current license is materially different from old descriptions calling it MIT/open source. Its commercial and competing-product restrictions make it unsuitable as an assumed free foundation for this product. [Current Screenpipe license](https://github.com/screenpipe/screenpipe/blob/main/LICENSE.md)

**Implementation order and acceptance gates.** Complete each gate before expanding capture scope.

| Stage | Deliverable | Evidence required |
| --- | --- | --- |
| 1. Capture/storage spike | Windows tray shell, Chrome/Edge events, selected-folder baseline and watcher, SQLite timeline | Real app switches and browser navigation; file locks/atomic saves/renames/deletes; sleep/wake; resource measurements; a packaged Windows build with native dependencies |
| 2. Recovery | Version timeline, copy-out preview, explicit overwrite flow, named checkpoint manifest | Original bytes recovered exactly; backup failure aborts overwrite; concurrent changes detected; interruption/corruption tested |
| 3. Recall | Typed timeline/text search, Gemini answers with evidence, optional semantic ranking | Small labeled dataset covering the four example questions, ambiguous titles, paraphrases, missing captures, and insufficient evidence |
| 4. Temporary-data lifecycle | Expiry, pinning, quotas, pause/delete, encryption, extension cleanup | Expired data absent from every retrieval path and unreferenced stores; pinned artifacts retained; real crash/restart behavior |
| 5. Expansion | More app adapters, macOS, optional cloud storage | Each integration has a support matrix; cloud deletion, key recovery, storage versioning, and conflict behavior are verified |

Useful benchmark scenarios include an eight-hour ordinary session, a large source checkout inside an excluded tree, a burst of saves, a locked Word file, duplicate filenames, a browser worker restart, and a full-disk condition. Record observed CPU, background RAM, disk growth, capture gaps, retrieval accuracy, and restore success. Set budgets after measurement rather than publishing invented resource claims.

The smallest convincing demo is: start a session, read two permitted articles, open a known PDF, switch to VS Code, edit a protected Word/text file, ask the example questions, recover a saved version through a reviewed action, and demonstrate that unpinned session evidence expires.
