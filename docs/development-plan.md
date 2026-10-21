# Development plan

The starter is Phase 0's technical foundation. Subsequent phases deliver complete, tested slices; they are not a request to implement the whole product now. Rasit approves architecture/contracts/dependencies, then module owners implement independently against ports. See [task backlog](team-tasks.md) for per-task branches and acceptance criteria.

## Phase 0 — Foundation and design contracts

Deliverable: runnable shell, strict contracts, tested in-memory lifecycle and IPC, inactive extension, ownership/docs/CI. This initialization provides that code. Rasit still reviews the scaffold and proposed ADRs, configures remote repository rules, and chooses the project license. Abdullah/Hacer refine UI/privacy flows while Mohammed investigates schema/encryption and Mohammad tests platform capabilities using synthetic data.

Acceptance: `npm ci`, `npm run check`, `npm run build`, `npm run test:app`, and local dev launch work on Windows; no monitoring or real history is enabled. Preserve original research. Do not push/publish without authorization. Document native-host and encryption decisions before implementation.

## Phase 1 — Lifecycle, basic collectors, SQLite

Rasit adds utility-process supervision and the engine consent/generation/shutdown protocol. Mohammed designs versioned migrations and implements repositories using generated test records after the encryption/build decision. Mohammad builds opt-in Windows foreground/idle/lock adapters with bounded normalization and explicit capability gaps. Hacer/Abdullah refine session status, timeline cards, and empty/error states independently using approved fixtures.

Integration depends on the host protocol plus repository/event ports; schema tests and collector tests do not depend on each other. Do not store real user history before encrypted storage and key handling are approved and available. Acceptance: an explicitly consented test session survives the intended lifecycle; pause/end/restart reject delayed events; migrations/repositories have integrity tests; exact packaged native dependencies launch on Windows. Tray-only lifetime/durable-session policy is resolved at this gate.

## Phase 2 — Saved versions and safe recovery

Mohammad's folder watcher provides scoped saved-change signals. Rasit orchestrates baseline/stable-read/capture queues and recovery validation. Mohammed implements immutable encrypted content storage and metadata integrity under the approved key design. Hacer/Abdullah can design/implement comparison and confirmation screens against proposal fixtures before privileged execution is available.

Dependencies: Phase 1 consent/utility/storage boundaries, encrypted blob/key spike, approved recovery contracts. Acceptance: known original bytes round-trip; baseline status is truthful; repeated/atomic saves, locks, exclusions, corruption, quota and crash cases are covered; copy-out is default; a failed safety copy or concurrent target change makes overwrite impossible. No model is involved.

## Phase 3 — Timeline, browsers, checkpoints

Mohammad delivers Chrome/Edge metadata and the separately installed native bridge, followed by optional article extraction. Mohammed provides checkpoint relationships/pinning; Rasit implements checkpoint lifecycle/reopen authorization. Hacer integrates real timeline and checkpoint views with Abdullah's state specifications.

Browser work can proceed against a synthetic ingestion adapter while checkpoint storage/engine work proceeds independently. Host security/install/permission approval is required before native integration. Acceptance: both browsers demonstrate consent/focus/exclusion/private restrictions and lifecycle races; native host install/update/uninstall and worker restarts are tested; timeline references actual observations; checkpoints report missing captures and cannot promise unsaved-state restoration.

## Phase 4 — Evidence search and optional Gemini

Mohammed delivers FTS5 indexing/query fixtures; Hacer delivers keyword and evidence UI with Abdullah's citation/uncertainty design. Mohammad can integrate bounded document text extraction in utility jobs, preserving originals. Rasit adds validated application tools and only then a consent-gated official `@google/genai` adapter.

Keyword search has no cloud dependency. Gemini integration depends on existing retrieval/authorization/citation contracts, explicit cloud consent, credential storage, and provider-data disclosure. Acceptance: labeled recall examples return supported sources; missing/ambiguous evidence is stated; excluded/expired data cannot be retrieved; tool budgets and network payloads are tested; model requests cannot execute recovery.

## Phase 5 — Privacy, retention, packaging, release evidence

Encryption is designed/proven before sensitive persistence; this phase completes its hardening rather than postponing basic encryption until the end. Mohammed finalizes encrypted migration/journal/FTS/blob coverage, quota/retention queries and storage integrity. Rasit integrates cleanup/pinning/deletion and final failure testing. Hacer implements real settings/deletion/consent controls; Mohammad integrates signed installer/native registration with Rasit; Abdullah reviews UX/accessibility.

Acceptance: clean-machine Windows install/update/uninstall, native ABI and key failures, permission revocation, locked/idle/resume, storage pressure, cross-store deletion/kept artifacts, original-byte recovery, crash recovery, offline operation and minimized optional Gemini payloads all have evidence. Choose and test signing/update/distribution policy. Complete dependency notices/license review. Rasit gives final release approval; no publishing is automatic.

## Sequencing for a five-person team

Keep one small implementation PR per person active when possible. Land approved contract additions before downstream code. Integrate a thin vertical slice early in each phase rather than letting every module drift for weeks. Demo at each phase gate with real evidence and recorded limitations. Use synthetic fixtures for parallel work and failures; never use fabricated activity in the ordinary app timeline. If the encryption/native spike fails, stop that dependent integration and return alternatives to Rasit rather than swapping the approved stack silently.
