import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { copyNativeRuntime } from "./package-runtime";

const config: ForgeConfig = {
  packagerConfig: {
    asar: { unpack: "**/prebuilds/*.node" },
    executableName: "Rewind",
    afterCopy: [
      async ({ buildPath, platform, arch }) =>
        copyNativeRuntime(buildPath, platform, arch),
    ],
  },
  rebuildConfig: { ignoreModules: ["better-sqlite3-multiple-ciphers"] },
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
