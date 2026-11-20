import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
export function newSecureFixture(): string {
  return mkdtempSync(resolve(tmpdir(), "rewind-secure-test-"));
}
export function removeSecureFixture(directory: string): void {
  const scoped = relative(resolve(tmpdir()), resolve(directory));
  if (
    isAbsolute(scoped) ||
    scoped.startsWith("..") ||
    !scoped.startsWith("rewind-secure-test-")
  )
    throw new Error("Unsafe fixture cleanup");
  rmSync(directory, { recursive: true, force: true });
}
