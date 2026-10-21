# Dependencies, references, and licenses

No ActivityWatch, aw-watcher-web, or ZFileTimeMachine implementation source is copied into Rewind. Package-manager dependencies remain external dependencies under their own licenses. Rewind's original-source license is an owner decision; packages are private and marked `UNLICENSED` for now. Do not describe this as a licensed open-source release until that decision is made.

## Used by the starter

Direct package licenses below were checked against the installed package metadata on 17 October 2026. Exact resolved versions/transitives are in `package-lock.json`; this is a practical dependency summary, not a full release notice bundle.

| Dependency                                  | Role                                | License / action                                                                                      |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Electron 44.9.0                             | Desktop runtime                     | MIT for Electron; preserve its license and bundled Chromium/third-party notices in distributed builds |
| Electron Forge 8.0.1 plugins/CLI/ZIP maker  | Build/package tooling               | MIT; preserve applicable notices                                                                      |
| React / React DOM 19.3.1                    | Renderer UI                         | MIT; preserve license/copyright in distribution                                                       |
| Vite 8.3.4 / React plugin                   | Bundling and development            | MIT; review bundled/transitive notices                                                                |
| TypeScript 5.9.3                            | Strict type checking                | Apache-2.0                                                                                            |
| Zod 4.6.7                                   | Runtime schemas at trust boundaries | MIT; bundled into privileged/preload contracts                                                        |
| Vitest 5.0.5                                | Unit and contract tests             | MIT                                                                                                   |
| Playwright Test 1.64.1                      | Packaged Electron tests             | Apache-2.0; no Playwright browser binary download required                                            |
| ESLint 10.13.0, typescript-eslint, Prettier | Code quality                        | MIT for these main tools; audit their exact transitive packages before distribution                   |

MIT/BSD distributions generally require retaining their copyright/license notices. Apache-2.0 distributions require its license and applicable NOTICE material, plus marking adapted source changes as required by the license. Use the actual dependency's license/notice files and a versioned inventory when preparing a release, rather than assuming this summary covers every bundled component. No third-party source adaptation has happened in the starter.

## Approved future libraries and study references

These libraries are **not installed** by this initialization. Check the exact chosen revision/version/license before incorporating them; review current APIs and packaged Windows compatibility first.

| Library/reference                                                   | Intended use                                        | License / boundary                                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [ActivityWatch](https://github.com/ActivityWatch/activitywatch)     | Study watcher/event architecture                    | MPL-2.0; no source copied                                                                                      |
| [aw-watcher-web](https://github.com/ActivityWatch/aw-watcher-web)   | Study browser collection; possible later adaptation | MPL-2.0; adapting covered files requires notices and corresponding covered source obligations when distributed |
| [get-windows](https://github.com/sindresorhus/get-windows)          | Windows foreground metadata                         | MIT; native/runtime packaging spike required                                                                   |
| [@parcel/watcher](https://github.com/parcel-bundler/watcher)        | Selected-folder notifications                       | MIT; native/runtime packaging and shutdown tests required                                                      |
| [Mozilla Readability](https://github.com/mozilla/readability)       | Permissioned article extraction                     | Apache-2.0; preserve license/applicable notices                                                                |
| [PDF.js](https://github.com/mozilla/pdf.js)                         | Supported PDF text/preview                          | Apache-2.0; review worker/assets and notices                                                                   |
| [Mammoth](https://github.com/mwilliamson/mammoth.js)                | DOCX raw-text extraction                            | BSD-2-Clause; preserve original file bytes separately                                                          |
| [Official Gemini SDK](https://github.com/googleapis/js-genai)       | Optional bounded Gemini assistant                   | Apache-2.0; API usage additionally subject to provider terms; no ADK                                           |
| [ZFileTimeMachine](https://github.com/TheHolyOneZ/ZFileTimeMachine) | Recovery UX reference only                          | GPL-covered implementation must not be copied into Rewind under this plan                                      |
| Encryption-enabled SQLite binding/build                             | Required encrypted database with FTS5               | Unselected; inspect native binding, cipher distribution, crypto and commercial/community terms before approval |

The existing research mentions additional candidates for later phases. They are not starter dependencies or permission to change this stack. No screenshot-capture product or external backup service is part of initialization.

## If MPL-covered browser code is adapted later

Track the upstream revision and every adapted file; retain license/copyright notices and identify modifications. Keep covered files/modifications under MPL-2.0, provide the covered source and source-availability notice to executable recipients as required, and review how bundling/minification affects the corresponding-source notice. Separate original files can have another compatible project license. Read the actual license before distribution. [Mozilla MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)

Before release, Rasit and the relevant owner review the lockfile and native binaries, collect exact LICENSE/NOTICE material (including Chromium), verify source-provision obligations, choose Rewind's license, and record the result with the release evidence. No publication is authorized by this document.
