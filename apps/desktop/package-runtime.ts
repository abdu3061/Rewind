import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** Vite excludes node_modules; copy only the reviewed native runtime and its license. */
export async function copyNativeRuntime(
  buildPath: string,
  platform: string,
  arch: string,
): Promise<void> {
  if (platform !== "win32" || arch !== "x64")
    throw new Error(
      "Only the verified Windows x64 native target is supported.",
    );
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const source = path.dirname(
    require.resolve("better-sqlite3-multiple-ciphers/package.json"),
  );
  const manifest = JSON.parse(
    await readFile(path.join(source, "package.json"), "utf8"),
  ) as { version: string };
  if (manifest.version !== "13.1.1")
    throw new Error("Unverified encrypted database dependency version.");
  const target = path.join(
    buildPath,
    "node_modules",
    "better-sqlite3-multiple-ciphers",
  );
  await mkdir(path.join(target, "prebuilds"), { recursive: true });
  for (const name of ["lib", "package.json", "LICENSE"])
    await cp(path.join(source, name), path.join(target, name), {
      recursive: true,
    });
  await cp(
    path.join(source, "prebuilds", "win32-x64.node"),
    path.join(target, "prebuilds", "win32-x64.node"),
  );
  const api = path.dirname(require.resolve("node-addon-api/package.json"));
  await cp(api, path.join(buildPath, "node_modules", "node-addon-api"), {
    recursive: true,
  });
}
