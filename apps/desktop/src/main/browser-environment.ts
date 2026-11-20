import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { win32 as path } from "node:path";
import { failure, type Result } from "@rewind/contracts";
import {
  nativeBridgeConfigSchema,
  type NativeBridgeConfig,
} from "./browser-bridge";

const maxImageBytes = 256 * 1024 * 1024;
const imagePath = nativeBridgeConfigSchema.shape.desktopPath;
/** Utility-only bounded fingerprint of the main-owned executable. Native peer proof remains mandatory. */
export async function fingerprintDesktopImage(
  file: string,
): Promise<Result<{ path: string; hash: string }>> {
  try {
    if (
      process.platform !== "win32" ||
      !imagePath.safeParse(file).success ||
      !file.toLowerCase().endsWith(".exe")
    )
      throw new Error("DESKTOP_IMAGE_PATH_UNSUPPORTED");
    const entry = await lstat(file, { bigint: true });
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1n ||
      entry.size < 1n ||
      entry.size > BigInt(maxImageBytes)
    )
      throw new Error("DESKTOP_IMAGE_UNSUPPORTED");
    const handle = await open(file, "r");
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.ino !== entry.ino ||
        before.size !== entry.size ||
        before.mtimeNs !== entry.mtimeNs ||
        before.ctimeNs !== entry.ctimeNs
      )
        throw new Error("DESKTOP_IMAGE_CHANGED");
      const hash = createHash("sha256");
      let bytes = 0;
      const stream = handle.createReadStream({
        start: 0,
        end: Number(before.size) - 1,
        highWaterMark: 65536,
        autoClose: false,
      });
      for await (const chunk of stream) {
        bytes += (chunk as Buffer).length;
        if (bytes > maxImageBytes) throw new Error("DESKTOP_IMAGE_LIMIT");
        hash.update(chunk as Buffer);
      }
      const after = await handle.stat({ bigint: true });
      if (
        bytes !== Number(before.size) ||
        after.size !== before.size ||
        after.nlink !== 1n ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new Error("DESKTOP_IMAGE_CHANGED");
      return { ok: true, value: { path: file, hash: hash.digest("hex") } };
    } finally {
      await handle.close();
    }
  } catch {
    return failure(
      "UNAVAILABLE",
      "The current desktop image could not be fingerprinted for browser setup.",
    );
  }
}

/** Checks only known executable locations; it never reads browser profiles, tabs or history. */
export async function discoverBrowserInstallations(
  environment: Record<string, string | undefined> = process.env,
): Promise<NativeBridgeConfig["browsers"]> {
  if (process.platform !== "win32") return [];
  const slots = [
    {
      kind: "chrome" as const,
      suffix: "Google\\Chrome\\Application\\chrome.exe",
      roots: [
        environment.ProgramFiles,
        environment["ProgramFiles(x86)"],
        environment.LOCALAPPDATA,
      ],
    },
    {
      kind: "edge" as const,
      suffix: "Microsoft\\Edge\\Application\\msedge.exe",
      roots: [
        environment["ProgramFiles(x86)"],
        environment.ProgramFiles,
        environment.LOCALAPPDATA,
      ],
    },
  ];
  const result: NativeBridgeConfig["browsers"] = [];
  for (const slot of slots)
    for (const root of new Set(
      slot.roots.filter((value): value is string => Boolean(value)),
    )) {
      const file = path.join(root, slot.suffix);
      if (!imagePath.safeParse(file).success) continue;
      try {
        const info = await lstat(file);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size < 1 ||
          info.size > maxImageBytes
        )
          continue;
        result.push({ kind: slot.kind, path: file });
        break;
      } catch {
        /* A missing/inaccessible installation is unavailable, not a profile-discovery fallback. */
      }
    }
  return result;
}
