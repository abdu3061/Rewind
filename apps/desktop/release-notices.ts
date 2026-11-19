import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// Include runtime roots bundled by Vite as well as copied/external native assets.
const roots = [
  "electron",
  "react",
  "react-dom",
  "@phosphor-icons/react",
  "zod",
  "@google/genai",
  "better-sqlite3-multiple-ciphers",
  "node-addon-api",
  "pdfjs-dist",
  "sax",
  "yauzl",
  "@napi-rs/canvas",
  "@napi-rs/canvas-win32-x64-msvc",
];

interface Manifest {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export async function generateReleaseNotices(
  desktopDirectory: string,
): Promise<void> {
  const output = path.join(desktopDirectory, ".generated", "notices");
  await mkdir(output, { recursive: true });
  const seen = new Set<string>();
  const inventory: {
    name: string;
    version: string;
    license: string;
    notices: { file: string; sha256: string }[];
  }[] = [];

  async function visit(name: string, from: string): Promise<void> {
    const require = createRequire(path.join(from, "package.json"));
    let source: string | undefined;
    for (const directory of require.resolve.paths(name) ?? []) {
      const candidate = path.join(directory, name);
      try {
        const manifest = JSON.parse(
          await readFile(path.join(candidate, "package.json"), "utf8"),
        ) as Manifest;
        if (manifest.name === name) {
          source = candidate;
          break;
        }
      } catch {
        /* Try the next normal Node resolution location. */
      }
    }
    if (!source) throw new Error(`Missing release notice dependency: ${name}`);
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    ) as Manifest;
    const id = `${manifest.name}@${manifest.version}`;
    if (seen.has(id)) return;
    seen.add(id);
    const notices: { file: string; sha256: string }[] = [];
    const target = path.join(output, "packages", id.replaceAll("/", "__"));
    async function copyNotices(
      directory: string,
      relative = "",
      depth = 0,
    ): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (
          entry.isSymbolicLink() ||
          entry.name === "node_modules" ||
          entry.name === ".git"
        )
          continue;
        const file = path.join(relative, entry.name);
        if (entry.isDirectory() && depth < 6)
          await copyNotices(path.join(directory, entry.name), file, depth + 1);
        else if (
          entry.isFile() &&
          /^(licen[cs]e|notice|copying|copyright|authors)([._-]|$)/i.test(
            entry.name,
          )
        ) {
          const destination = path.join(target, file);
          await mkdir(path.dirname(destination), { recursive: true });
          await cp(path.join(source!, file), destination);
          notices.push({
            file: file.replaceAll(path.sep, "/"),
            sha256: createHash("sha256")
              .update(await readFile(destination))
              .digest("hex"),
          });
        }
      }
    }
    await copyNotices(source);
    inventory.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "REVIEW_REQUIRED",
      notices: notices.sort((a, b) => a.file.localeCompare(b.file)),
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (!(dependency in (manifest.optionalDependencies ?? {})))
        await visit(dependency, source);
    }
    // Canvas/PDF optional Windows assets are explicit roots, not all-platform binaries.
  }
  for (const name of roots) await visit(name, desktopDirectory);
  inventory.sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
  await writeFile(
    path.join(output, "inventory.json"),
    `${JSON.stringify({ format: 1, target: "win32-x64", packages: inventory }, null, 2)}\n`,
  );
  await writeFile(
    path.join(output, "README.txt"),
    "Rewind Windows beta — third-party notices\n\ninventory.json records exact installed runtime roots and required dependency closures. This intentionally includes some bundled-tool/unused transitive code; it is not a legal certification or a complete embedded-native SBOM. Original license/notice files are preserved under packages/. Packages without notice files and embedded SQLite/crypto/Skia/font notices require owner review before distribution. Electron's LICENSE and LICENSES.chromium.html remain beside Rewind.exe. Rewind original source remains private and UNLICENSED pending the owner's license decision.\n",
  );
}
