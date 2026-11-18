import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { copyNativeRuntime } from "./package-runtime";
import { generateBrowserAssets } from "./browser-assets";
import { generateDocumentAssets } from "./document-assets";
import { copyDocumentRuntime } from "./document-runtime";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));

const config: ForgeConfig = {
  packagerConfig: {
    asar: { unpack: "**/{*.node,icudtl.dat}" },
    executableName: "Rewind",
    extraResource: [
      path.join(desktopDirectory, ".generated", "browser"),
      path.join(desktopDirectory, ".generated", "documents"),
    ],
    afterCopy: [
      async ({ buildPath, platform, arch }) => {
        await copyNativeRuntime(buildPath, platform, arch);
        await copyDocumentRuntime(buildPath, platform, arch);
      },
    ],
  },
  rebuildConfig: { ignoreModules: ["better-sqlite3-multiple-ciphers"] },
  hooks: {
    generateAssets: async (_config, platform, arch) => {
      await generateBrowserAssets(desktopDirectory, platform, arch);
      await generateDocumentAssets(desktopDirectory, platform, arch);
    },
  },
  makers: [new MakerZIP({}, ["win32"])],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/document-entry.ts",
          config: "vite.document.config.ts",
          target: "main",
        },
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
