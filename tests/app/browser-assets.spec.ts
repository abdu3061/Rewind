import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readBrowserAssets } from "../../apps/desktop/src/main/browser-assets";
import { verificationExecutable } from "./fixtures";

test("Windows package contains verified native host and normal extension assets outside ASAR without installing a host", async () => {
  test.skip(process.platform !== "win32", "Windows x64 package required.");
  const root = path.join(
    path.dirname(verificationExecutable()),
    "resources",
    "browser",
  );
  const result = await readBrowserAssets(root);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const executable = path.join(root, result.value.inventory.native.name);
  expect(await lstat(`${executable}.json`).catch(() => null)).toBeNull();
  const launched = spawnSync(executable, [], {
    windowsHide: true,
    timeout: 5000,
    encoding: "utf8",
  });
  expect(launched.error).toBeUndefined();
  expect(launched.status).toBe(1);
  expect(launched.stdout).toBe("");
  expect(launched.stderr).toBe("");
});
