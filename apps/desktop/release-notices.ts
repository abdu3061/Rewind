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
    // This package preserves its full MIT grant in README rather than LICENSE.
    if (name === "data-uri-to-buffer" && notices.length === 0) {
      const file = "README.md";
      const bytes = await readFile(path.join(source, file));
      if (!bytes.includes("Permission is hereby granted"))
        throw new Error("Missing data-uri-to-buffer license grant");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, file), bytes);
      notices.push({
        file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    if (name === "@napi-rs/canvas-win32-x64-msvc") {
      const bytes = await readFile(path.resolve(source, "../canvas/LICENSE"));
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "LICENSE"), bytes);
      notices.push({
        file: "LICENSE",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    if (notices.length === 0)
      throw new Error(`Missing release license material: ${id}`);
    inventory.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "REVIEW_REQUIRED",
      notices: notices.sort((a, b) => a.file.localeCompare(b.file)),
    });
    // Electron's download/install dependencies are build tools, not runtime code.
    // The actual runtime's Electron/Chromium notices remain beside Rewind.exe.
    if (name === "electron") return;
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (!(dependency in (manifest.optionalDependencies ?? {})))
        await visit(dependency, source);
    }
    // Canvas/PDF optional Windows assets are explicit roots, not all-platform binaries.
  }
  for (const name of roots) await visit(name, desktopDirectory);
  const nativeSource = path.join(
    desktopDirectory,
    "assets",
    "third-party-notices",
  );
  const nativeProvenance = JSON.parse(
    await readFile(path.join(nativeSource, "provenance.json"), "utf8"),
  ) as {
    canvasBindingSha256: string;
    sqliteAmalgamationSha256: string;
    failures: unknown[];
    files: { file: string; sha256: string }[];
  };
  if (nativeProvenance.failures.length !== 0)
    throw new Error("Native notice collection is incomplete");
  const nativeRequire = createRequire(
    path.join(desktopDirectory, "package.json"),
  );
  const canvasBinding = nativeRequire.resolve("@napi-rs/canvas-win32-x64-msvc");
  const sqliteManifest = nativeRequire.resolve(
    "better-sqlite3-multiple-ciphers/package.json",
  );
  for (const [file, expected] of [
    [canvasBinding, nativeProvenance.canvasBindingSha256],
    [
      path.join(path.dirname(sqliteManifest), "deps/sqlite3/sqlite3.c"),
      nativeProvenance.sqliteAmalgamationSha256,
    ],
  ])
    if (
      createHash("sha256")
        .update(await readFile(file!))
        .digest("hex") !== expected
    )
      throw new Error(
        "Native notices do not match the installed source/binary",
      );
  await cp(nativeSource, path.join(output, "native"), { recursive: true });
  for (const entry of nativeProvenance.files) {
    if (
      !/^[a-zA-Z0-9@._/-]+$/.test(entry.file) ||
      entry.file.split("/").includes("..")
    )
      throw new Error("Invalid native notice path");
    const bytes = await readFile(path.join(output, "native", entry.file));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error("Native notice integrity mismatch");
  }
  inventory.sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
  await writeFile(
    path.join(output, "inventory.json"),
    `${JSON.stringify({ format: 1, target: "win32-x64", packages: inventory }, null, 2)}\n`,
  );
  await writeFile(
    path.join(output, "README.txt"),
    "Rewind Windows beta — third-party notices\n\ninventory.json records exact installed runtime roots and required dependency closures. Original license/notice files are preserved under packages/. native/provenance.json records additional native dependency notices, their upstream sources and SHA-256 values; it includes the canvas binary's published SBOM, Rust/Skia dependency notices, unmodified MPL crate source archives and the installed SQLite amalgamation's verbatim copyright/license comment blocks. Electron's LICENSE and LICENSES.chromium.html remain beside Rewind.exe. No fonts are bundled by Rewind's interface. Rewind original source remains UNLICENSED; this is not an open-source license grant or independent legal certification.\n",
  );
}
