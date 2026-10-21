# ADR 0001 — Lightweight workspaces and Forge/Vite

Date: 17 October 2026. Status: Accepted for initialization under the user's approved stack. Owner: Rasit.

Use npm workspaces for two applications and five domain packages. Private packages expose TypeScript source, bundled by Vite and tested by Vitest; TypeScript performs strict no-emit checking. Electron Forge's official Vite plugin owns the main, preload, and renderer builds. Root commands are the team entry point. Installed Forge 8 emits `.cjs` main/preload entries, and the configuration uses those exact paths.

This avoids parallel tsc watch/build graphs, unpublished precompiled package artifacts, and alias-only resolution. Main/preload bundles include the runtime contract/engine code. React is bundled into renderer assets; build dependencies are intentionally devDependencies in the desktop manifest so unused source workspaces are not packaged as runtime modules.

No native SQLite/window/watcher/parsing/AI dependencies are installed until used. The native spike must externalize and rebuild appropriate dependencies for Electron, handle ASAR, and test a Windows package. Forge/Vite is documented as experimental, so lockfile/tool version changes require package-and-launch evidence. [Official Forge Vite configuration](https://www.electronforge.io/config/plugins/vite)

`build` creates an unpacked desktop package and extension assets; `make` creates a Windows ZIP. A signed installer, host installation, and update distribution are later owner-approved work. An alternative separate package compilation graph was rejected for the starter because the private apps already bundle source and no library is published.
