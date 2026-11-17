import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "vite";
import {
  browserAssetInventorySchema,
  browserHostName,
  developmentExtensionId,
  readBrowserAssets,
} from "./src/main/browser-assets";

/** Build-time only: no registration, user profile, runtime compiler or consent changes. */
export async function generateBrowserAssets(
  desktopDirectory: string,
  platform: string,
  arch: string,
  output = path.join(desktopDirectory, ".generated", "browser"),
): Promise<void> {
  if (process.platform !== "win32" || platform !== "win32" || arch !== "x64")
    throw new Error(
      "Browser assets support only the verified Windows x64 target.",
    );
  const extension = path.resolve(desktopDirectory, "../browser-extension");
  await mkdir(output, { recursive: true });
  const native = path.join(output, "RewindBrowserHost.exe");
  const compiler = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  await promisify(execFile)(
    compiler,
    [
      "/nologo",
      "/target:exe",
      "/platform:x64",
      "/optimize+",
      "/r:System.Web.Extensions.dll",
      `/out:${native}`,
      path.join(desktopDirectory, "src/native/browser-process-proof.cs"),
      path.join(desktopDirectory, "src/native/browser-native-program.cs"),
      path.join(desktopDirectory, "src/native/browser-registration.cs"),
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
  await build({
    root: extension,
    configFile: path.join(extension, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir: path.join(output, "extension"), emptyOutDir: true },
  });
  const describe = async (directory: string, name: string) => {
    const bytes = await readFile(path.join(directory, name));
    return {
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const inventory = browserAssetInventorySchema.parse({
    version: 1,
    hostName: browserHostName,
    extensionId: developmentExtensionId,
    native: await describe(output, "RewindBrowserHost.exe"),
    extension: await Promise.all(
      (await readdir(path.join(output, "extension")))
        .sort()
        .map((name) => describe(path.join(output, "extension"), name)),
    ),
  });
  await writeFile(
    path.join(output, "assets.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  if (!(await readBrowserAssets(output)).ok)
    throw new Error("Generated browser assets failed verification.");
}
