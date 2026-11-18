import { lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Explicit CLI-only synthetic verification mode, isolated from the user's actual profile. */
export function validateFixtureRoot(value: string): string | null {
  if (!value) return null;
  const root = path.resolve(value);
  const relative = path.relative(path.resolve(tmpdir()), root);
  if (
    !relative.startsWith("rewind-e2e-") ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error("INVALID_FIXTURE_ROOT");
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())
    throw new Error("INVALID_FIXTURE_ROOT");
  const marker = path.join(root, "synthetic-fixture.json");
  if (lstatSync(marker).isSymbolicLink() || lstatSync(marker).size > 256)
    throw new Error("INVALID_FIXTURE_ROOT");
  const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("synthetic" in parsed) ||
    parsed.synthetic !== true ||
    !("format" in parsed) ||
    parsed.format !== 1 ||
    Object.keys(parsed).length !== 2
  )
    throw new Error("INVALID_FIXTURE_ROOT");
  return root;
}
/** Optional, CLI-profile-only browser fixture. The host namespace and asset folder are fixed/bounded. */
export function readBrowserFixture(
  root: string | null,
): { root: string; hostName: string } | null {
  if (!root) return null;
  const file = path.join(root, "browser-fixture.json");
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256)
    throw new Error("INVALID_BROWSER_FIXTURE");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "format,hostName" ||
    !("format" in value) ||
    value.format !== 1 ||
    !("hostName" in value) ||
    typeof value.hostName !== "string" ||
    !/^com\.rewind\.test\.[a-f0-9]{32}$/.test(value.hostName)
  )
    throw new Error("INVALID_BROWSER_FIXTURE");
  return { root: path.join(root, "browser-assets"), hostName: value.hostName };
}

/** A fixed offline assistant seam exists only in an explicitly validated CLI test profile. */
export function readAssistantFixture(root: string | null): boolean {
  if (!root) return false;
  const file = path.join(root, "assistant-fixture.json");
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256)
    throw new Error("INVALID_ASSISTANT_FIXTURE");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "format,syntheticAssistant" ||
    !("format" in value) ||
    value.format !== 1 ||
    !("syntheticAssistant" in value) ||
    value.syntheticAssistant !== true
  )
    throw new Error("INVALID_ASSISTANT_FIXTURE");
  return true;
}
