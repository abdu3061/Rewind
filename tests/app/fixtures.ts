import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, test as base } from "@playwright/test";

function removeProfile(profile: string): void {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(profile));
  if (
    !relative.startsWith("rewind-e2e-") ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error("Unsafe verification profile cleanup");
  rmSync(profile, { recursive: true, force: true });
}
export const test = base.extend<{ profile: string }>({
  profile: async ({ baseURL }, use) => {
    void baseURL;
    const profile = mkdtempSync(path.join(tmpdir(), "rewind-e2e-"));
    writeFileSync(
      path.join(profile, "synthetic-fixture.json"),
      JSON.stringify({ format: 1, synthetic: true }),
    );
    try {
      await use(profile);
    } finally {
      removeProfile(profile);
    }
  },
});
export function launchVerificationApp(profile: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  return electron.launch({
    executablePath: path.resolve(
      `apps/desktop/out/Rewind-${process.platform}-${process.arch}/Rewind.exe`,
    ),
    env,
    args: [`--rewind-fixture-root=${profile}`],
  });
}
