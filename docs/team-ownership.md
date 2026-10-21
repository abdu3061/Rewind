# Team ownership

Rasit is the project owner, technical lead, primary backend developer, and final integrator. He has final authority over architecture, public interfaces, dependencies, privacy/security, recovery behavior, merges to `main`, and release approval. This review authority does not transfer implementation ownership of every feature to him.

| Team member                                    | Owned deliverables                                                                                                                                                                                                                 | Primary files                                                                             | Required collaboration                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rasit — @RXD3**                              | Architecture/configuration; session engine; collector coordination/authorization; snapshot/version orchestration; checkpoint engine; recovery validation; assistant/Gemini and tool policy; integration/final tests/release review | `packages/engine`, `packages/assistant`, desktop main/preload composition, contracts/ADRs | Approve contracts before dependent changes; integrate storage/collectors; consult Hacer/Abdullah on user consent/recovery                                |
| **Hacer Dilara — Frontend**                    | React shell, dashboard/session controls, timeline/activity cards, search/evidence display, checkpoint browsing, version comparison/recovery confirmation, settings/privacy frontend                                                | `apps/desktop/src/renderer`                                                               | Consume approved DesktopApi; pair with Abdullah on specifications/tokens; request new privileged methods through Rasit                                   |
| **Mohammed Bashli — Database/storage**         | SQLite schema/versioned migrations; repository implementations; FTS5; session/activity/version/checkpoint records; integrity tests; retention queries/usage; encryption-build integration support                                  | `packages/storage`                                                                        | Agree blob references, transactions, retention pins, and key boundaries with Rasit; provide fixture-backed repository tests for UI/collector integration |
| **Mohammad Poorhamadi — Backend/integrations** | `get-windows` collector; extension; permitted metadata/article extraction; `@parcel/watcher`; idle/lock investigation; event normalization; browser/native bridge; integration tests                                               | `packages/collectors`, `apps/browser-extension`, future desktop native-host composition   | Agree consent/session generation/ingestion contracts with Rasit; coordinate event indexing with Mohammed; document capture gaps for frontend             |
| **Abdullah — UI/UX**                           | UX/Figma, navigation/information architecture, journeys, typography/color/spacing tokens, reusable component/state specifications, session/privacy indicators, recovery/checkpoint flows, window resizing behavior, UI review      | Design files plus `docs/design/` when needed; renderer token specifications               | Work directly with Hacer and Rasit; design paused/off/unsupported/error states before polished screens; review accessibility and confirmation clarity    |

Hacer must not implement OS monitoring, database access, or privileged file operations in React. Mohammed owns the database layer without independently choosing file-recovery policy. Mohammad's collectors cannot grant their own consent or resume monitoring. Abdullah's deliverables include actionable screen/state and component specifications, not only visual mood boards.

## Handoffs that enable independent work

1. Contracts supply stable events, sources, settings, repository ports, collector lifecycle, and session API. Rasit reviews changes promptly; every owner proposes needed contract changes as a separate small PR.
2. Hacer can develop empty/loading/error/evidence views with explicitly test-only or development-labeled adapters behind DesktopApi. No fake data is displayed as actual captured history.
3. Mohammed can implement migrations and repository tests with synthetic schema-validated records before collectors exist. Encryption feasibility uses generated fixtures, never real user history.
4. Mohammad can test normalization and lifecycle with synthetic emitter/ingestion ports before SQLite exists. No automatic collection during module import or app startup.
5. Abdullah can specify flows and neutral token replacements in parallel with engine and database work. Hacer implements approved flows; Rasit reviews privacy/recovery semantics.

## Review and integration

Every substantial task has a feature branch and PR, scoped acceptance criteria, test evidence, and limitations. Each module owner reviews related changes. Rasit gives final technical/merge approval, and must review public contracts, architecture, dependency strategy, security/consent, and recovery changes. Cross-module PRs explicitly name both owners and land shared contracts first.

Only Rasit's GitHub username is known. `.github/CODEOWNERS` routes all review requests to `@RXD3` for now; update it after real teammate accounts are supplied. The owner must manually configure repository rules, restricted merges, and team access. CODEOWNERS by itself does not enforce approval or final merge authority. See [contributing](contributing.md).

## First individual assignments

| Person              | First task                                                                             | Can start independently?                           |
| ------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Rasit               | RWD-100: utility-process host and engine consent/generation protocol                   | Yes, using existing ports and synthetic collectors |
| Hacer               | RWD-001: accessible dashboard/session UX refinement and renderer service/error states  | Yes, existing live session API                     |
| Mohammed Bashli     | RWD-003: schema/migration design and encryption packaging feasibility spike with Rasit | Yes, synthetic repository fixtures                 |
| Mohammad Poorhamadi | RWD-004: Windows/idle/lock and Native Messaging capability investigation               | Yes, isolated opt-in test harnesses                |
| Abdullah            | RWD-002: navigation, design tokens, consent/privacy and recovery journey specs         | Yes, specification and starter as reference        |

See [team tasks](team-tasks.md) for dependencies, acceptance, branches, and follow-up assignments.
