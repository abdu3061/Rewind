# ADR 0002 — Validated capability IPC

Date: 17 October 2026. Status: Accepted for initialization. Owner: Rasit.

Keep React sandboxed and isolated with Node integration off. Preload exposes explicit session methods and validates arguments, responses, and state events. Main validates the strict command, exact known window, main-frame identity, and renderer location. No generic IPC, filesystem, model, database, or arbitrary URL-opening methods cross the bridge.

Packaged assets use a secure standard custom protocol with bounded root resolution, strict production CSP, and no renderer network connections. Development uses a loopback Vite server and a per-server CSP nonce for React Refresh. All browser permissions, external navigation, popup windows, and webviews are denied.

Zod is the small shared runtime-validation dependency. Static types alone cannot validate data crossing a compromised renderer, extension, native host, or future utility worker. Future privileged capabilities require a narrow contract and independent engine authorization, not just a new `ipcMain` handler. [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

Consequences: UI work must use approved capabilities; new interfaces need lead review. Packaged-app tests check a working bridge, absence of Node globals, sandbox metrics, and denial to another window.
