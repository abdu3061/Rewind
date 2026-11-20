import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { copyNativeRuntime } from "./package-runtime";
import { generateBrowserAssets } from "./browser-assets";
import { generateDocumentAssets } from "./document-assets";
import { copyDocumentRuntime } from "./document-runtime";
import { generateReleaseNotices } from "./release-notices";
import { releaseSigning } from "./release-signing";
import { generateBuildReceipt } from "./release-build";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.dirname(fileURLToPath(import.meta.url));
const windowsSign = releaseSigning(desktopDirectory);

const config: ForgeConfig = {
  packagerConfig: {
    asar: { unpack: "**/{*.node,icudtl.dat}" },
    executableName: "Rewind",
    icon: path.join(desktopDirectory, "assets", "rewind.ico"),
    appBundleId: "com.rewind.desktop",
    ...(windowsSign ? { windowsSign } : {}),
    win32metadata: {
      CompanyName: "Rewind team",
      FileDescription: "Rewind — local work-session memory and recovery",
      ProductName: "Rewind",
      InternalName: "Rewind",
    },
    extraResource: [
      path.join(desktopDirectory, "assets", "rewind.png"),
      path.join(desktopDirectory, ".generated", "browser"),
      path.join(desktopDirectory, ".generated", "documents"),
      path.join(desktopDirectory, ".generated", "notices"),
      path.join(desktopDirectory, ".generated", "release"),
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
    preMake: async () => {
      if (process.env.REWIND_RELEASE_ARTIFACT !== "1")
        throw new Error(
          "Use the root npm run make command for release artifacts.",
        );
    },
    generateAssets: async (_config, platform, arch) => {
      await generateBrowserAssets(desktopDirectory, platform, arch);
      await generateDocumentAssets(desktopDirectory, platform, arch);
      await generateReleaseNotices(desktopDirectory);
      await generateBuildReceipt(desktopDirectory);
    },
  },
  makers: [
    new MakerZIP({}, ["win32"]),
    new MakerSquirrel({
      name: "Rewind",
      authors: "Rewind team",
      description: "Local, consent-driven work-session memory and recovery.",
      setupExe: "Rewind-Setup.exe",
      setupIcon: path.join(desktopDirectory, "assets", "rewind.ico"),
      loadingGif: path.join(desktopDirectory, "assets", "installer.gif"),
      // Keep the installed-app identity consistent instead of Squirrel's Electron icon.
      iconUrl:
        "https://raw.githubusercontent.com/abdu3061/Rewind/v0.1.0-beta.1/apps/desktop/assets/rewind.ico",
      title: "Rewind",
      noMsi: true,
      noDelta: true,
      ...(windowsSign ? { windowsSign } : {}),
    }),
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // Playwright needs the main-process inspector for package verification only.
      // Root make always builds fresh artifacts with this disabled before signing.
      [FuseV1Options.EnableNodeCliInspectArguments]:
        process.env.REWIND_RELEASE_ARTIFACT !== "1",
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
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
