import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  lstat,
  realpath,
  readFile,
  open,
  link,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { failure, type Result } from "@rewind/contracts";

export interface KeyProtector {
  available(): Promise<boolean>;
  protect(bytes: Uint8Array): Promise<Uint8Array>;
  unprotect(bytes: Uint8Array): Promise<Uint8Array>;
}
export const secureDatabaseName = "history.sqlite";
export const protectedKeyName = "history.key";
const unavailable = () =>
  failure(
    "UNAVAILABLE",
    "Windows-protected storage key is unavailable. Existing history was not replaced.",
  );
const missing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

export async function preparePrivateDirectory(
  directory: string,
): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error("PRIVATE_ROOT_INVALID");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("PRIVATE_ROOT_INVALID");
  const parent = await realpath(path.dirname(directory));
  const actual = await realpath(directory);
  const expected = path.join(parent, path.basename(directory));
  if (
    process.platform === "win32"
      ? actual.toLowerCase() !== expected.toLowerCase()
      : actual !== expected
  )
    throw new Error("PRIVATE_ROOT_CHANGED");
}

/** Stores only protected bytes. The Electron composition supplies the Windows DPAPI adapter. */
export class ProtectedKeyStore {
  constructor(
    private readonly directory: string,
    private readonly protector: KeyProtector,
  ) {}
  async load(): Promise<Result<Uint8Array>> {
    try {
      if (!(await this.protector.available())) return unavailable();
      await preparePrivateDirectory(this.directory);
      const keyFile = path.join(this.directory, protectedKeyName);
      try {
        await lstat(keyFile);
        return await this.readExisting(keyFile);
      } catch (error) {
        if (!missing(error)) return unavailable();
      }
      // Never generate a replacement key for existing history, even an unreadable/empty file.
      try {
        await lstat(path.join(this.directory, secureDatabaseName));
        return unavailable();
      } catch (error) {
        if (!missing(error)) return unavailable();
      }
      const key = randomBytes(32);
      let temporary: string | null = null;
      try {
        const protectedBytes = Buffer.from(await this.protector.protect(key));
        if (!protectedBytes.length || protectedBytes.length > 2048)
          return unavailable();
        const verified = Buffer.from(
          await this.protector.unprotect(protectedBytes),
        );
        const matches =
          verified.length === key.length && timingSafeEqual(verified, key);
        verified.fill(0);
        if (!matches) return unavailable();
        temporary = path.join(
          this.directory,
          `.protected-key-${randomUUID()}.tmp`,
        );
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              format: 1,
              protectedKey: protectedBytes.toString("base64"),
            }),
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Atomic create without replacing another process's key. No overwrite/rename fallback.
        try {
          await link(temporary, keyFile);
        } catch (error) {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          ))
            return unavailable();
        }
        return await this.readExisting(keyFile);
      } finally {
        key.fill(0);
        if (temporary) {
          try {
            await unlink(temporary);
          } catch {
            /* Only already-protected bytes can remain. */
          }
        }
      }
    } catch {
      return unavailable();
    }
  }
  private async readExisting(file: string): Promise<Result<Uint8Array>> {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4096)
      return unavailable();
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).sort().join(",") !== "format,protectedKey" ||
      !("format" in value) ||
      value.format !== 1 ||
      !("protectedKey" in value) ||
      typeof value.protectedKey !== "string"
    )
      return unavailable();
    const wrapped = Buffer.from(value.protectedKey, "base64");
    if (!wrapped.length || wrapped.toString("base64") !== value.protectedKey)
      return unavailable();
    const key = Buffer.from(await this.protector.unprotect(wrapped));
    if (key.length !== 32) {
      key.fill(0);
      return unavailable();
    }
    return { ok: true, value: key };
  }
}
