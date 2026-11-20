# ADR 0026: compatible tooling updates for glob advisories

18 November 2026. Local dependency maintenance under the authorized core goal, pending Rasit's dependency review. No release, merge or publication is implied.

## Evidence and decision

Adding the official Gemini SDK prompted a clean-install dependency audit. The first install reported zero findings, while the subsequent clean install/full audit reported 28. Comparing every affected module's resolved version with local commit `e44095d` proved all 28 affected versions were already present and unchanged; the new SDK did not introduce these findings. Do not treat the earlier zero result as current audit evidence.

The underlying advisories concern `glob` cancellation, `minimatch` pattern amplification and `picomatch` extglob backtracking. Update compatible upstream tooling rather than accept audit's suggested broad framework downgrades. Pin ESLint 10.15.0 and typescript-eslint 8.73.0, and refresh the existing compatible `@electron/asar` dependency to 4.3.2. The resulting lockfile resolves glob 14.0.6 and minimatch 11.0.9, above the published fixes. Node 22.13+ remains supported. No override, dependency framework, native binding replacement or application API change is required. Preserve the native package's prebuild-only lock metadata through `lock:prepare`.

The resulting full audit reports 23 high entries propagated from the single remaining `picomatch` advisory, which has no published fixed version. It is used by the required Vite/Vitest build/test tooling. Rewind's recording/recovery adapters and assistant tools do not interpret user titles, URLs, paths, questions or exclusions as glob patterns. This limits the present exposure; it does not patch the package or establish immunity. Keep this as a release/tooling follow-up, monitor the upstream fix and avoid attacker-supplied glob configurations. The production-only audit reports zero known vulnerabilities; that is not a general security certification.

## Verification and ownership

Run a fresh `npm ci`, install metadata check, TypeScript, lint, formatting, all unit tests, the Windows build and packaged/native-browser suites against the final lockfile. The integration report records actual outcomes. The new SDK itself is separately bounded and tested under ADR 0025; no model request is enabled by dependency installation. Rasit reviews dependencies and final release risk. Native/compiler/collector privacy gates remain unchanged.

References: [glob advisory and patched version](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), [minimatch advisory and patched version](https://github.com/advisories/GHSA-g3hv-75wg-m249), [picomatch advisory without a published fix](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).
