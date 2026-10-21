# Rewind project plan

Rewind will be a Windows desktop application that acts as temporary memory for a work session. It will help users remember websites, applications, and supported files they worked with, recover earlier saved file versions, and reopen the resources belonging to a checkpoint. The first release will focus on Windows, Chrome, and Edge.

Users will start a session, choose which folders to protect, and continue working normally. Rewind will record useful events with timestamps and preserve temporary copies of supported files. Users can browse a timeline or ask questions such as “Which website about machine learning did I visit?” and “What was I working on around 2 PM?” Answers will include the relevant time and a link to the recorded resource. When evidence is missing or ambiguous, Rewind will explain the uncertainty.

The first version will include:

- **Session controls:** start, pause, resume, and end a session, with a system-tray indicator showing whether collection is active. Closing the main window will leave an active session running in the tray; quitting will stop collection.
- **An activity timeline:** foreground applications and window titles, Chrome/Edge page visits and titles, file changes in selected folders, and timestamps. Idle and locked periods will be distinguished from active work.
- **Browser recall:** a browser extension will collect visits and, on sites where the user allows it, readable article text. This makes topic searches useful even when the topic is missing from the page title. Content extraction will have a clear supported-site boundary.
- **Known-file recall:** files opened through Rewind will have a known path that can be linked to the timeline and reopened. The first version will not promise exact document identification across every application. Files changed in selected folders can still be versioned when opened outside Rewind.
- **Natural-language search:** Gemini will search through application-controlled tools for timeline entries, websites, supported document text, and saved file versions. Users can also use ordinary keyword and date filters.
- **Temporary file versions:** Rewind will capture an initial copy when protection starts and later successfully captured saved states. Initial support will cover text/code files, Markdown, `.docx`, and ordinary PDFs, with file-size limits. Recovery preserves original file bytes, including Word formatting; searchable text is stored separately.
- **Reviewed recovery:** users will choose a version, inspect its time and preview, then explicitly confirm recovery. Saving a recovered copy will be the default. Before an approved overwrite, Rewind must successfully preserve the current version; if that fails, the overwrite stops.
- **Manual named checkpoints:** users can save selected file versions, URLs, and project-folder references together, then reopen selected resources or recover individual files. Checkpoints will report any resources they could not capture.
- **Temporary local storage:** a configurable retention period, initially 72 hours, automatic expiration, a disk quota, session deletion, and a Keep option for checkpoints. Keeping a checkpoint retains its selected artifacts beyond normal expiration.
- **Privacy controls:** collection exclusions for apps, sites, and folders; private-browser exclusion; encrypted stored data and OS-protected keys. Rewind will record structured events and selected file copies. Screen/audio recording and general computer control are outside the first release.

Two limits will be clear in the product: Rewind can recover only versions it successfully saved, and a checkpoint cannot resume arbitrary unsaved edits or application memory. A PDF-before-VS-Code question can have an exact answer when the PDF identity was recorded, such as when it was opened through Rewind; otherwise, Rewind will show the available candidates.

The application will have three internal parts: collectors that produce timestamped events, a local storage/recovery engine that owns file versions and checkpoints, and an assistant that searches the stored evidence. AI will propose actions through validated tools. The application will enforce restore confirmation independently of the model.

The chosen first-release stack is:

| Part | Technology | Purpose |
| --- | --- | --- |
| Desktop app | Electron, React, TypeScript, Vite | Windows interface, tray controls, timeline, chat, and recovery screens |
| Background engine | Node.js in an Electron utility process | Collect events, process files, maintain storage, and run assistant tools separately from the UI |
| Application activity | `get-windows` | Foreground application and window metadata |
| Browser integration | TypeScript Manifest V3 extension for Chrome/Edge | Visit information, permitted page text, and resource reopening |
| File monitoring | `@parcel/watcher` | Notify the engine about changes in selected folders |
| Local database | SQLite with FTS5 | Store structured history and provide keyword/time search; use an encryption-enabled build for release |
| File versions | Encrypted immutable files in the app's local data directory | Preserve original bytes; use hashes to verify contents and avoid duplicate copies |
| Content extraction | Mozilla Readability, PDF.js, Mammoth | Extract permitted article text, read ordinary PDFs, and extract `.docx` text |
| AI | Gemini API through the official `@google/genai` TypeScript SDK | Interpret questions, call search tools, and explain retrieved evidence |
| Packaging | Electron Forge | Package the Windows installer and native dependencies |

Google ADK will not be required in the first release. A single assistant with a small set of search and proposal tools is sufficient for the initial workflows. SQLite keyword/time search will be implemented first; semantic embeddings will be a later improvement measured against actual missed queries.

Session history and file versions will remain on the computer in version one. Cloud AI is a separate setting: when enabled, the user's question and the necessary retrieved excerpts will be sent to Gemini. Disabling it will leave the timeline, keyword search, checkpoints, and recovery available. The initial pilot will use a user-provided API key protected by the OS; a shared provider key will never be embedded in the desktop app. Provider-side request handling is outside Rewind's local expiration policy. [Gemini API terms](https://ai.google.dev/gemini-api/terms)

The code-reuse plan is specific:

| Repository | How we will use it | License |
| --- | --- | --- |
| [ActivityWatch](https://github.com/ActivityWatch/activitywatch) | Study its watcher/event/heartbeat architecture; build Rewind's own timeline and lifecycle around those concepts | MPL-2.0 |
| [aw-watcher-web](https://github.com/ActivityWatch/aw-watcher-web) | Adapt its browser tab-tracking code into a Rewind extension, adding Rewind consent, filtering, transport, and permitted article extraction | MPL-2.0 |
| [get-windows](https://github.com/sindresorhus/get-windows) | Install and use as a library for active-window metadata | MIT |
| [parcel-bundler/watcher](https://github.com/parcel-bundler/watcher) | Install `@parcel/watcher` as a library for filesystem notifications | MIT |
| [mozilla/readability](https://github.com/mozilla/readability) | Use as a library for extracting readable article text on permitted sites | Apache-2.0 |
| [mozilla/pdf.js](https://github.com/mozilla/pdf.js) | Use for supported PDF viewing and text extraction | Apache-2.0 |
| [mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js) | Use for `.docx` text extraction and text previews, preserving the original document separately | BSD-2-Clause |
| [googleapis/js-genai](https://github.com/googleapis/js-genai) | Use the official Gemini SDK | Apache-2.0 |

The adapted ActivityWatch extension files and their modifications will remain under MPL-2.0, with the required source access and notices when distributed. Separate original Rewind files can have their own license. [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)

We will study [ZFileTimeMachine](https://github.com/TheHolyOneZ/ZFileTimeMachine) for recovery UI ideas and architecture, without copying its GPL-covered implementation into the first release. Rewind's session lifecycle, version store, recovery validation, checkpoint format, permissions, and search tools will be original code. Screenpipe will not be a dependency or code source for this plan.

After the first version is reliable, the next release will add a VS Code extension and tested integrations for more document applications, automatic scheduled/grouped checkpoints, and better handling of moved resources. It will also add semantic search using local embeddings and [sqlite-vec](https://github.com/asg017/sqlite-vec), evaluated against the first release's search results. Image-only PDF OCR and richer document comparisons will follow as supported capabilities.

Later releases will add macOS, Firefox, optional fully local AI, and optional encrypted cloud synchronization or backup. Large workspace checkpoints will evaluate [restic](https://github.com/restic/restic), licensed BSD-2-Clause, as the backup engine. It will not be required for the initial bounded document-version store. Linux support will follow a separate desktop-environment capture investigation. Cloud synchronization will require account/key recovery, conflict handling, and deletion behavior to be designed before release.

Implementation will proceed in this order: prove Windows capture and packaged native dependencies; build and test file versioning/recovery; add the timeline and manual checkpoints; connect Gemini to validated search tools; then complete retention, privacy, encryption, and failure testing before the first release. Each stage will use real browser/app activity and real file saves, including locks, rapid changes, restarts, and interrupted recovery.

The first-release demonstration will cover one complete work session: visit two permitted articles, open a known PDF, switch to VS Code, change a protected document, answer the recall questions with evidence, recover an earlier captured version through confirmation, reopen a checkpoint's resources, and show that unkept history expires.
