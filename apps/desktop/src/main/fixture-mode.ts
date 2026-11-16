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
