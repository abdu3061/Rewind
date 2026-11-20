import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ProtectedKeyStore,
  protectedKeyName,
  secureDatabaseName,
  type KeyProtector,
} from "./key-store";
import {
  newSecureFixture,
  removeSecureFixture,
} from "./secure-fixtures.test-support";
let directory: string;
beforeEach(() => {
  directory = newSecureFixture();
});
afterEach(() => removeSecureFixture(directory));
function protector(): KeyProtector {
  // Test-only authenticated protector; production exclusively injects Windows safeStorage.
  const testKey = randomBytes(32);
  return {
    available: vi.fn(async () => true),
    protect: vi.fn(async (bytes) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", testKey, iv);
      return Buffer.concat([
        iv,
        cipher.update(bytes),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    }),
    unprotect: vi.fn(async (bytes) => {
      const value = Buffer.from(bytes);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        testKey,
        value.subarray(0, 12),
      );
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([
        decipher.update(value.subarray(12, -16)),
        decipher.final(),
      ]);
    }),
  };
}
it("creates one protected key and reuses it, including simultaneous creation", async () => {
  const p = protector();
  const store = new ProtectedKeyStore(directory, p);
  const results = await Promise.all([store.load(), store.load()]);
  expect(results.every((result) => result.ok)).toBe(true);
  if (!results[0]?.ok || !results[1]?.ok) throw new Error("Expected keys");
  expect(Buffer.from(results[0].value)).toEqual(Buffer.from(results[1].value));
  expect(
    readFileSync(join(directory, protectedKeyName)).includes(
      Buffer.from(results[0].value),
    ),
  ).toBe(false);
});
it("does not regenerate a missing key when history already exists", async () => {
  const p = protector();
  const store = new ProtectedKeyStore(directory, p);
  expect((await store.load()).ok).toBe(true);
  writeFileSync(join(directory, secureDatabaseName), "synthetic history");
  unlinkSync(join(directory, protectedKeyName));
  vi.mocked(p.protect).mockClear();
  expect((await store.load()).ok).toBe(false);
  expect(p.protect).not.toHaveBeenCalled();
  expect(existsSync(join(directory, protectedKeyName))).toBe(false);
});
it("preserves an unavailable or corrupted protected key instead of replacing it", async () => {
  const p = protector();
  const store = new ProtectedKeyStore(directory, p);
  await store.load();
  const file = join(directory, protectedKeyName);
  const original = readFileSync(file);
  vi.mocked(p.unprotect).mockRejectedValueOnce(
    new Error("Synthetic DPAPI unavailable"),
  );
  expect((await store.load()).ok).toBe(false);
  expect(readFileSync(file)).toEqual(original);
  writeFileSync(file, "corrupted synthetic key");
  expect((await store.load()).ok).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("corrupted synthetic key");
});
it("does not write keys when protection is unavailable", async () => {
  const p = protector();
  vi.mocked(p.available).mockResolvedValue(false);
  expect((await new ProtectedKeyStore(directory, p).load()).ok).toBe(false);
  expect(existsSync(join(directory, protectedKeyName))).toBe(false);
});
