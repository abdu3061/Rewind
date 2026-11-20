import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Result } from "@rewind/contracts";

export const developmentExtensionId = "coenmeplfkocojebfacfbebinadfijoh";
export const browserHostName = "com.rewind.bridge";
export const browserHostNamePattern =
  /^(com\.rewind\.bridge|com\.rewind\.test\.[a-f0-9]{32})$/;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024),
  sha256: digest,
});
export const browserAssetInventorySchema = z.strictObject({
  version: z.literal(1),
  hostName: z.string().regex(browserHostNamePattern),
  extensionId: z.literal(developmentExtensionId),
  nativeSourceHash: digest,
  native: z.strictObject({
    name: z.literal("RewindBrowserHost.exe"),
    bytes: z
      .number()
      .int()
      .min(1024)
      .max(4 * 1024 * 1024),
    sha256: digest,
  }),
  extension: z
    .array(file)
    .min(5)
    .max(64)
    .refine(
      (files) =>
        new Set(files.map((item) => item.name.toLowerCase())).size ===
          files.length &&
        files.reduce((total, item) => total + item.bytes, 0) <=
          2 * 1024 * 1024 &&
        [
          "manifest.json",
          "background.js",
          "popup.js",
          "status.html",
          "popup.css",
        ].every((name) => files.some((item) => item.name === name)),
    ),
});
export type BrowserAssetInventory = z.infer<typeof browserAssetInventorySchema>;
export interface VerifiedBrowserAssets {
  inventory: BrowserAssetInventory;
  native: Buffer;
  extensionDirectory: string;
}

async function readBounded(file: string, limit: number): Promise<Buffer> {
  const entry = await lstat(file, { bigint: true });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size < 1n ||
    entry.size > BigInt(limit)
  )
    throw new Error("BROWSER_ASSET_INVALID");
  const handle = await open(file, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size !== entry.size ||
      before.ino !== entry.ino
    )
      throw new Error("BROWSER_ASSET_CHANGED");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read.bytesRead) throw new Error("BROWSER_ASSET_CHANGED");
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("BROWSER_ASSET_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function directory(file: string): Promise<string[]> {
  const entry = await lstat(file);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("BROWSER_ASSET_DIRECTORY_INVALID");
  return readdir(file);
}

/** Build/utility package integrity check. Installation still requires native destination proof. */
export async function readBrowserAssets(
  root: string,
  expectedHostName: string = browserHostName,
): Promise<Result<VerifiedBrowserAssets>> {
  try {
    const names = await directory(root);
    if (
      names.length !== 3 ||
      !["assets.json", "RewindBrowserHost.exe", "extension"].every((name) =>
        names.includes(name),
      )
    )
      throw new Error("BROWSER_ASSET_LAYOUT_INVALID");
    const inventory = browserAssetInventorySchema.parse(
      JSON.parse(
        (await readBounded(path.join(root, "assets.json"), 65536)).toString(
          "utf8",
        ),
      ),
    );
    if (inventory.hostName !== expectedHostName)
      throw new Error("BROWSER_ASSET_NAMESPACE_MISMATCH");
    const native = await readBounded(
      path.join(root, inventory.native.name),
      4 * 1024 * 1024,
    );
    if (
      native.length !== inventory.native.bytes ||
      createHash("sha256").update(native).digest("hex") !==
        inventory.native.sha256
    )
      throw new Error("BROWSER_ASSET_HASH_INVALID");
    const extensionDirectory = path.join(root, "extension");
    const entries = await directory(extensionDirectory);
    if (
      entries.length !== inventory.extension.length ||
      entries.some(
        (name) => !inventory.extension.some((item) => item.name === name),
      )
    )
      throw new Error("BROWSER_ASSET_LAYOUT_INVALID");
    for (const item of inventory.extension) {
      const bytes = await readBounded(
        path.join(extensionDirectory, item.name),
        1024 * 1024,
      );
      if (
        bytes.length !== item.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== item.sha256
      )
        throw new Error("BROWSER_ASSET_HASH_INVALID");
    }
    return { ok: true, value: { inventory, native, extensionDirectory } };
  } catch {
    return {
      ok: false,
      error: {
        code: "INTEGRITY_FAILURE",
        message:
          "Browser setup assets are missing, changed or unsupported. Rebuild or reinstall Rewind.",
      },
    };
  }
}
