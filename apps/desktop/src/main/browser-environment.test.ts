import { createHash } from "node:crypto";
import { link, mkdir, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  discoverBrowserInstallations,
  fingerprintDesktopImage,
} from "./browser-environment";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

let root: string;
beforeEach(() => {
  root = newSecureFixture();
});
afterEach(() => removeSecureFixture(root));
it.skipIf(process.platform !== "win32")(
  "fingerprints exact bounded synthetic bytes and denies shared, empty, oversized or unsupported images",
  async () => {
    const file = path.join(root, "SyntheticDesktop.exe"),
      bytes = Buffer.alloc(1024 * 1024 + 19, 93);
    await writeFile(file, bytes);
    expect(await fingerprintDesktopImage(file)).toEqual({
      ok: true,
      value: {
        path: file,
        hash: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    await link(file, path.join(root, "shared.exe"));
    expect((await fingerprintDesktopImage(file)).ok).toBe(false);
    const empty = path.join(root, "empty.exe");
    await writeFile(empty, "");
    expect((await fingerprintDesktopImage(empty)).ok).toBe(false);
    await truncate(empty, 256 * 1024 * 1024 + 1);
    expect((await fingerprintDesktopImage(empty)).ok).toBe(false);
    expect((await fingerprintDesktopImage("relative.exe")).ok).toBe(false);
    expect(
      (await fingerprintDesktopImage(path.join(root, "missing.exe"))).ok,
    ).toBe(false);
  },
);
it.skipIf(process.platform !== "win32")(
  "discovers only bounded known synthetic executable locations without profile reads or duplicates",
  async () => {
    const programFiles = path.join(root, "ProgramFiles"),
      local = path.join(root, "LocalAppData"),
      x86 = path.join(root, "ProgramFilesX86");
    const chrome = path.join(
        programFiles,
        "Google/Chrome/Application/chrome.exe",
      ),
      alternate = path.join(local, "Google/Chrome/Application/chrome.exe"),
      edge = path.join(x86, "Microsoft/Edge/Application/msedge.exe");
    for (const file of [chrome, alternate, edge]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "synthetic executable metadata fixture");
    }
    const environment = {
      ProgramFiles: programFiles,
      "ProgramFiles(x86)": x86,
      LOCALAPPDATA: local,
    };
    expect(await discoverBrowserInstallations(environment)).toEqual([
      { kind: "chrome", path: chrome },
      { kind: "edge", path: edge },
    ]);
    await writeFile(chrome, "");
    expect(await discoverBrowserInstallations(environment)).toEqual([
      { kind: "chrome", path: alternate },
      { kind: "edge", path: edge },
    ]);
    expect(await discoverBrowserInstallations({})).toEqual([]);
    expect(
      await discoverBrowserInstallations({ ProgramFiles: "relative" }),
    ).toEqual([]);
  },
);
