# First Windows evaluation beta deployment

20 November 2026. The product owner explicitly requested: "ok do what you need and then deploy the beta" after accepting an unsigned limited-beta route with deferred wider-release acceptance. This authorizes preparation and publishing to the existing `abdu3061/Rewind` repository as a prerelease; it does not authorize a merge into `main`, background recording consent or access to personal files. The release branch preserves all automatic-recording, capture-gap, Timeline and change-only recording fixes.

## Candidate

- Desktop version: `0.1.0-beta.1`, Windows x64, unsigned.
- Branch: `release/windows-beta-0.1.0`.
- Downloads: production Squirrel installer, portable ZIP, SHA-256 release manifest and beta notes.
- Source licensing remains `UNLICENSED`; no open-source license is selected. Explicit owner distribution authorization covers this evaluation release. Independent licensing/security certification is not claimed.
- [Beta notes](../beta-notes.md) disclose collection/recovery scope, missing manual acceptance, trust warnings, manual browser setup and manual updates.

## Notice remediation

Release packaging now requires license material for every inventoried runtime package. Electron's download-only tooling is excluded from runtime dependency traversal; the actual Electron/Chromium runtime notices remain preserved. `data-uri-to-buffer`'s installed README contains its original full MIT grant; the canvas platform binding retains its parent project's license.

Additional notices are committed under `apps/desktop/assets/third-party-notices`. `provenance.json` records SHA-256 values and immutable upstream sources. Its canvas SBOM is verified against the installed binary. The bundle includes Rust dependency licenses, exact unmodified MPL source crate archives, pinned Skia/dependency notices (including FreeType's FTL text and libjpeg's IJG README), and verbatim copyright/license comment blocks from the actual SQLite amalgamation. Generation rejects incomplete collection or source/binary/notice mismatch; final release verification rehashes these files. The beta UI uses installed Windows fonts, not a new embedded font asset. These steps preserve material and provide traceability; they do not assert independent legal review.

## Verification

- Initial current-source `npm run check`: native lock, types, lint, formatting and 662 tests / 76 files passed (233.33 seconds).
- An initial full desktop run passed 32/33; the recording/filter/restart case timed out with a busy Chromium temporary-profile file during cleanup. Its unchanged focused trace run passed in 9.1 seconds. The complete beta-package suite is rerun before publication; no production deadline or assertion was weakened.
- Beta verification package built successfully from committed runtime source `c71743b`. Subsequent commits affect release verification only. Types, lint, formatting, native-lock metadata and all 256 committed original notice/source hashes pass.
- Complete beta-package desktop suite: **33/33 passed** (3.9 minutes), including Chrome/Edge UI flows, change-only/no-import/deduplication, exclusions, recovery/preservation, checkpoints/Keep, encrypted restart, consent, renderer/worker failure and storage deletion.
- Separate installed Chrome/Edge suite: **6/6 passed** (51.3 seconds), with marked synthetic profiles and scoped test host registrations.
- Actual packaged DOCX/PDF utility/native guard harness: **1/1 passed** (5.00 seconds).
- Final production packaging and hardened release checks are completed before publication; the manifest records the exact committed build source and artifact hashes. Installed-machine acceptance is not implied by these archive/runtime checks.

## Deferred acceptance

The host is not elevated and has no Windows Sandbox executable or disposable Windows VM available. Do not install into the owner's actual profile as a substitute. Clean-device install/newer-version upgrade/uninstall/reinstall and real signed-publisher acceptance remain unverified. Physical Known Folder/OneDrive/offline behavior, long-duration whole-system/resource profiling, display/accessibility review, independent security review and live Gemini acceptance remain outstanding. These limits must accompany the prerelease; they are not reported as passed.
