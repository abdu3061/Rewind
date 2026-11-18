import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/** Build-time only; no runtime compiler or user profile. */
export async function generateDocumentAssets(
  desktopDirectory: string,
  platform: string,
  arch: string,
): Promise<void> {
  if (process.platform !== "win32" || platform !== "win32" || arch !== "x64")
    throw new Error("Unsupported document utility target.");
  const output = path.join(desktopDirectory, ".generated", "documents");
  await mkdir(output, { recursive: true });
  const directory = await lstat(output);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (await realpath(output)).toLowerCase() !==
      path.resolve(output).toLowerCase()
  )
    throw new Error("Document assets must use a real build directory.");
  const executable = path.join(output, "RewindDocumentGuard.exe");
  const existing = await lstat(executable).catch((error: unknown) => {
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
    existing &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  )
    throw new Error("Document guard output must not redirect or share a file.");
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
      `/out:${executable}`,
      path.join(desktopDirectory, "src/native/document-resource-guard.cs"),
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
}
