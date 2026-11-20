import { spawnSync } from "node:child_process";
import path from "node:path";

// npm exposes its CLI path; use Node directly, avoiding Windows .cmd/shell quoting.
if (!process.env.npm_execpath)
  throw new Error("Run this through npm run make.");
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Only Windows x64 is verified.");
const result = spawnSync(
  process.execPath,
  [
    path.resolve(process.env.npm_execpath),
    "run",
    "make",
    "--workspace",
    "@rewind/desktop",
  ],
  {
    env: { ...process.env, REWIND_RELEASE_ARTIFACT: "1" },
    stdio: "inherit",
    windowsHide: true,
  },
);
process.exitCode = result.status ?? 1;
