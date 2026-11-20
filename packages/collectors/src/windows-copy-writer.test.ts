import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WindowsProtectedFileAccess } from "./windows-file-access";
import { WindowsRecoveryCopyWriter } from "./windows-copy-writer";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../storage/src/secure-fixtures.test-support";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeSecureFixture(root);
});
async function fixture() {
  const root = newSecureFixture();
  roots.push(root);
  const reader = new WindowsProtectedFileAccess();
  try {
    const proof = await reader.validateFolder(root);
    if (!proof.ok) throw new Error("Synthetic recovery directory unavailable");
    return {
      root,
      proof: proof.value,
      writer: new WindowsRecoveryCopyWriter(),
    };
  } finally {
    await reader.close();
  }
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
it.runIf(process.platform === "win32")(
  "writes and verifies a separate original-byte copy and never replaces an existing file",
  async () => {
    const f = await fixture(),
      bytes = Buffer.from([0, 255, 10, 13, 37, 99]);
    expect(
      await f.writer.createCopy(f.proof, "recovered.bin", bytes, digest(bytes)),
    ).toMatchObject({
      ok: true,
      value: { contentHash: digest(bytes), byteLength: bytes.length },
    });
    expect(readFileSync(join(f.root, "recovered.bin"))).toEqual(bytes);
    const replacement = Buffer.from("Different synthetic data");
    expect(
      await f.writer.createCopy(
        f.proof,
        "recovered.bin",
        replacement,
        digest(replacement),
      ),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(readFileSync(join(f.root, "recovered.bin"))).toEqual(bytes);
  },
  20000,
);
it.runIf(process.platform === "win32")(
  "rejects corrupted source bytes, traversal, replaced directories and reparse destinations",
  async () => {
    const f = await fixture(),
      bytes = Buffer.from("Synthetic recovery bytes");
    expect(
      (await f.writer.createCopy(f.proof, "bad.txt", bytes, "a".repeat(64))).ok,
    ).toBe(false);
    expect(
      (
        await f.writer.createCopy(
          f.proof,
          "..\\elsewhere.txt",
          bytes,
          digest(bytes),
        )
      ).ok,
    ).toBe(false);
    const child = join(f.root, "chosen");
    mkdirSync(child);
    const reader = new WindowsProtectedFileAccess();
    const proof = await reader.validateFolder(child);
    await reader.close();
    if (!proof.ok) throw new Error("Synthetic selected directory unavailable");
    renameSync(child, join(f.root, "original"));
    mkdirSync(child);
    expect(
      (
        await f.writer.createCopy(
          proof.value,
          "recovered.txt",
          bytes,
          digest(bytes),
        )
      ).ok,
    ).toBe(false);
    const outside = newSecureFixture();
    roots.push(outside);
    const existing = join(outside, "original.txt");
    writeFileSync(existing, "Unchanged synthetic original");
    symlinkSync(outside, join(f.root, "junction"), "junction");
    expect(
      (
        await f.writer.createCopy(
          { ...f.proof, absolutePath: join(f.root, "junction") },
          "original.txt",
          bytes,
          digest(bytes),
        )
      ).ok,
    ).toBe(false);
    expect(readFileSync(existing, "utf8")).toBe("Unchanged synthetic original");
  },
  20000,
);
it.runIf(process.platform === "win32")(
  "copies and verifies the complete maximum-sized snapshot through bounded private stdin",
  async () => {
    const f = await fixture(),
      bytes = Buffer.alloc(16 * 1024 ** 2, 51);
    expect(
      (await f.writer.createCopy(f.proof, "maximum.bin", bytes, digest(bytes)))
        .ok,
    ).toBe(true);
    expect(readFileSync(join(f.root, "maximum.bin")).equals(bytes)).toBe(true);
  },
  25000,
);
