import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(
  path.dirname(
    path.resolve(
      root,
      process.env.REWIND_TEST_EXECUTABLE ??
        "apps/desktop/out/Rewind-win32-x64/Rewind.exe",
    ),
  ),
  "resources",
);
if (process.platform !== "win32" || process.arch !== "x64") {
  console.error(
    "Document runtime verification requires the Windows x64 target.",
  );
  process.exit(1);
}
if (
  !existsSync(path.join(resources, "app.asar")) ||
  !existsSync(path.join(resources, "documents/RewindDocumentGuard.exe"))
) {
  console.error(
    "Build the current Windows application with npm run build first.",
  );
  process.exit(1);
}
const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    path.join(
      path.dirname(require.resolve("vitest/package.json")),
      "vitest.mjs",
    ),
    "run",
    "apps/desktop/src/main/document-utility.test.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, REWIND_TEST_DOCUMENT_PACKAGED: "1" },
  },
);
process.exit(result.status ?? 1);
