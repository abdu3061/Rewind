import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rename,
  writeFile,
  symlink,
  mkdir,
} from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { generateBrowserAssets } from "./browser-assets";
import {
  browserAssetInventorySchema,
  readBrowserAssets,
} from "./src/main/browser-assets";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../packages/storage/src/secure-fixtures.test-support";

let root: string, output: string;
beforeAll(async () => {
  if (process.platform !== "win32") return;
  root = newSecureFixture();
  output = path.join(root, "browser");
  await generateBrowserAssets(
    path.resolve("apps/desktop"),
    "win32",
    "x64",
    output,
  );
}, 20000);
afterAll(() => {
  if (root) removeSecureFixture(root);
});

it.skipIf(process.platform !== "win32")(
  "builds the actual native executable and normal extension without runtime configuration, and detects changed/missing/untracked assets",
  async () => {
    const result = await readBrowserAssets(output);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { inventory, native, extensionDirectory } = result.value;
    expect(native.subarray(0, 2).toString()).toBe("MZ");
    const pe = native.readUInt32LE(0x3c);
    expect(native.subarray(pe, pe + 4)).toEqual(
      Buffer.from([0x50, 0x45, 0, 0]),
    );
    expect(native.readUInt16LE(pe + 4)).toBe(0x8664);
    expect(createHash("sha256").update(native).digest("hex")).toBe(
      inventory.native.sha256,
    );
    expect(await readdir(output)).toEqual(
      expect.arrayContaining([
        "assets.json",
        "extension",
        "RewindBrowserHost.exe",
      ]),
    );
    expect(
      await lstat(path.join(output, "RewindBrowserHost.exe.json")).catch(
        () => null,
      ),
    ).toBeNull();
    const launch = spawnSync(path.join(output, inventory.native.name), [], {
      windowsHide: true,
      timeout: 5000,
      encoding: "utf8",
    });
    expect(launch.error).toBeUndefined();
    expect(launch.status).toBe(1);
    expect(launch.stdout).toBe("");
    expect(launch.stderr).toBe("");
    const manifest = JSON.parse(
      await readFile(path.join(extensionDirectory, "manifest.json"), "utf8"),
    ) as { key: string; permissions: string[]; incognito: string };
    expect(
      createHash("sha256")
        .update(Buffer.from(manifest.key, "base64"))
        .digest("hex")
        .slice(0, 32)
        .replace(/[0-9a-f]/g, (value) =>
          String.fromCharCode(97 + parseInt(value, 16)),
        ),
    ).toBe(inventory.extensionId);
    expect(manifest.permissions).toEqual([
      "tabs",
      "nativeMessaging",
      "storage",
    ]);
    expect(manifest.incognito).toBe("not_allowed");
    expect(
      await readFile(path.join(extensionDirectory, "background.js"), "utf8"),
    ).toContain(inventory.hostName);
    const popup = path.join(extensionDirectory, "popup.js"),
      original = await readFile(popup);
    await writeFile(
      popup,
      Buffer.concat([original, Buffer.from("\n// changed fixture")]),
    );
    expect(await readBrowserAssets(output)).toMatchObject({
      ok: false,
      error: { code: "INTEGRITY_FAILURE" },
    });
    await writeFile(popup, original);
    const outside = path.join(root, "untracked.js");
    await writeFile(outside, "// synthetic untracked extension script");
    await rename(outside, path.join(extensionDirectory, "untracked.js"));
    expect((await readBrowserAssets(output)).ok).toBe(false);
    await rename(path.join(extensionDirectory, "untracked.js"), outside);
    await rename(popup, path.join(root, "saved-popup.js"));
    expect((await readBrowserAssets(output)).ok).toBe(false);
    await rename(path.join(root, "saved-popup.js"), popup);
    await writeFile(
      path.join(output, inventory.native.name),
      Buffer.concat([
        native.subarray(0, -1),
        Buffer.from([native.at(-1)! ^ 1]),
      ]),
    );
    expect((await readBrowserAssets(output)).ok).toBe(false);
    await writeFile(path.join(output, inventory.native.name), native);
    expect((await readBrowserAssets(output)).ok).toBe(true);

    // A redirected extension directory must never be accepted as an installed asset set.
    const saved = path.join(root, "saved-extension"),
      redirected = path.join(root, "redirected");
    await rename(extensionDirectory, saved);
    await mkdir(redirected);
    await symlink(redirected, extensionDirectory, "junction");
    expect((await readBrowserAssets(output)).ok).toBe(false);
  },
);

it("rejects path traversal, case-colliding inventories and unsupported targets", async () => {
  await expect(
    generateBrowserAssets(path.resolve("apps/desktop"), "win32", "arm64"),
  ).rejects.toThrow("Windows x64");
  if (process.platform !== "win32") return;
  const inventory = JSON.parse(
    await readFile(path.join(output, "assets.json"), "utf8"),
  ) as { extension: { name: string }[] };
  const first = inventory.extension[0]!;
  const original = first.name;
  first.name = "../escape.js";
  expect(browserAssetInventorySchema.safeParse(inventory).success).toBe(false);
  first.name = original;
  inventory.extension.push({ ...first, name: original.toUpperCase() });
  expect(browserAssetInventorySchema.safeParse(inventory).success).toBe(false);
});
