# Initialization validation

Local validation date: 17 October 2026. Platform: Windows x64; Node 22.16.0, npm 11.7.0. These results apply to the starter and generated dependency lockfile, not to future native modules or production features. No remote CI run or release has been performed.

| Command / check     | Result                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`       | Installed dependencies and generated lockfile; installation audit reported zero vulnerabilities                                                                                                                           |
| `npm run typecheck` | Passed for shared packages, Electron main/preload, renderer, extension/config and application tests                                                                                                                       |
| `npm run lint`      | Passed                                                                                                                                                                                                                    |
| `npm test`          | 34 tests passed: full session transition matrix, invalid/nonmutating transitions, state-copy and clock behavior, boundary contracts, IPC dispatcher/location checks, inactive extension manifest                          |
| `npm run build`     | Passed: extension assets plus actual Forge Windows x64 packaged application                                                                                                                                               |
| `npm run test:app`  | 2 tests passed against the packaged Windows executable: live session controls/navigation, preload validation, unavailable Node globals, sandbox metrics, forbidden access from another window, fresh state after relaunch |
| `npm run dev`       | Forge/Vite launched successfully; a development-runtime smoke check started a session at the loopback page with no observed page/console errors; stopped after verification                                               |

Packaged dashboard screenshot was visually reviewed at `test-results/dashboard.png` (ignored local test evidence). It shows neutral replaceable tokens, readable navigation/session controls, inactive collection/privacy status, and explicit unimplemented feature notices. App tests never collect actual browsing activity or user files.

The host environment supplied `ELECTRON_RUN_AS_NODE`; direct Playwright launches remove that inherited variable so Electron runs as a GUI app. Forge's development launcher handles its own Electron startup. Tests use public app/process metrics rather than relying on undocumented WebContents preference getters.

Additional checks: `npm ci` passed from the generated lockfile (zero vulnerabilities reported); `npm run make` produced the unsigned Windows x64 ZIP at `apps/desktop/out/make/zip/win32/x64/Rewind-win32-x64-0.1.0.zip`. All local Markdown links in the new documentation were checked. Formatting is checked by `npm run check`.

Forge may emit upstream experimental-glob and recursive-rmdir deprecation warnings; Playwright may emit a color-environment warning. These are non-failing tool output, not proof of feature support. Forge's Vite integration remains experimental upstream and needs repeat build/launch checks on upgrades.

## Not verified or not implemented

Signed installer/update/uninstall, ARM64 or non-Windows support, packaged native SQLite/watcher/window modules, an encryption-enabled DB/blob/key system, durable history, background utility services, actual collection/consent shutdown races, Chrome/Edge native transport, file snapshots/recovery/checkpoints, FTS search, provider requests, real retention/deletion/quotas, and release licensing are outside this initialization. Extension build/manifest checks do not prove Chrome/Edge end-to-end behavior. GitHub repository rules still need manual owner configuration.
