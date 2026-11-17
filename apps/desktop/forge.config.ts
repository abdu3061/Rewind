import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { copyNativeRuntime } from "./package-runtime";
import { generateBrowserAssets } from "./browser-assets";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));

const config: ForgeConfig = {
  packagerConfig: {
    asar: { unpack: "**/prebuilds/*.node" },
    executableName: "Rewind",
    extraResource: [path.join(desktopDirectory, ".generated", "browser")],
    afterCopy: [
      async ({ buildPath, platform, arch }) =>
        copyNativeRuntime(buildPath, platform, arch),
    ],
  },
  rebuildConfig: { ignoreModules: ["better-sqlite3-multiple-ciphers"] },
  hooks: {
    generateAssets: async (_config, platform, arch) =>
      generateBrowserAssets(desktopDirectory, platform, arch),
  },
  makers: [new MakerZIP({}, ["win32"])],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/worker-entry.ts",
          config: "vite.worker.config.ts",
          target: "main",
        },
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};
export default config;
