import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** Copy the exact reviewed parser assets and Windows Node-API prebuild, without native compilation. */
export async function copyDocumentRuntime(
  buildPath: string,
  platform: string,
  arch: string,
): Promise<void> {
  if (platform !== "win32" || arch !== "x64")
    throw new Error("Unsupported document runtime target.");
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const packages = [
    {
      name: "pdfjs-dist",
      version: "6.5.438",
      files: [
        "package.json",
        "LICENSE",
        "legacy/build/pdf.mjs",
        "legacy/build/pdf.worker.mjs",
        "cmaps",
        "standard_fonts",
      ],
    },
    {
      name: "@napi-rs/canvas",
      version: "1.1.1",
      files: [
        "package.json",
        "LICENSE",
        "index.js",
        "geometry.js",
        "js-binding.js",
        "load-image.js",
      ],
    },
    {
      name: "@napi-rs/canvas-win32-x64-msvc",
      version: "1.1.1",
      files: [
        "package.json",
        "README.md",
        "skia.win32-x64-msvc.node",
        "icudtl.dat",
        "sbom.cdx.json",
      ],
    },
  ];
  for (const item of packages) {
    const source = path.dirname(require.resolve(`${item.name}/package.json`));
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    ) as { version: string };
    if (manifest.version !== item.version)
      throw new Error("Unverified document runtime version.");
    for (const file of item.files) {
      const target = path.join(buildPath, "node_modules", item.name, file);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(source, file), target, { recursive: true });
    }
  }
}
