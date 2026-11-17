import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
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
  const checkDirectory = async (directory: string) => {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)).toLowerCase() !==
        path.resolve(directory).toLowerCase()
    )
      throw new Error(
        "Browser asset output must be a real local build directory.",
      );
  };
  await checkDirectory(output);
  const extensionOutput = path.join(output, "extension");
  const existingExtension = await lstat(extensionOutput).catch(
    (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    },
  );
  if (existingExtension) await checkDirectory(extensionOutput);
  const native = path.join(output, "RewindBrowserHost.exe");
  const existingNative = await lstat(native).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  });
  if (
    existingNative &&
    (!existingNative.isFile() ||
      existingNative.isSymbolicLink() ||
      existingNative.nlink !== 1)
  )
    throw new Error(
      "Browser native output must not redirect or share another file.",
    );
  const compiler = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  const flags = [
    "/nologo",
    "/target:exe",
    "/platform:x64",
    "/optimize+",
    "/r:System.Web.Extensions.dll",
  ];
  const sources = [
    "browser-process-proof.cs",
    "browser-native-program.cs",
    "browser-registration.cs",
  ];
  const fingerprint = async () => {
    const hash = createHash("sha256").update(JSON.stringify(flags));
    for (const [name, file] of [
      ["compiler", compiler],
      ...sources.map(
        (name) =>
          [name, path.join(desktopDirectory, "src/native", name)] as const,
      ),
    ] as const) {
      const bytes = await readFile(file);
      hash.update(`${name}\0${bytes.length}\0`).update(bytes);
    }
    return hash.digest("hex");
  };
  const nativeSourceHash = await fingerprint();
  await promisify(execFile)(
    compiler,
    [
      ...flags,
      `/out:${native}`,
      path.join(desktopDirectory, "src/native/browser-process-proof.cs"),
      path.join(desktopDirectory, "src/native/browser-native-program.cs"),
      path.join(desktopDirectory, "src/native/browser-registration.cs"),
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
  if ((await fingerprint()) !== nativeSourceHash)
    throw new Error("Browser native build inputs changed during compilation.");
  await build({
    root: extension,
    configFile: path.join(extension, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir: extensionOutput, emptyOutDir: true },
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
    nativeSourceHash,
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
