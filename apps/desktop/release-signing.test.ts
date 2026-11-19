import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { releaseSigning } from "./release-signing";

it("fails a signing-required build without credentials and keeps unsigned local builds explicit", () => {
  expect(releaseSigning("synthetic", {})).toBeUndefined();
  expect(() =>
    releaseSigning("synthetic", { REWIND_REQUIRE_SIGNING: "1" }),
  ).toThrow("required");
  expect(() =>
    releaseSigning("synthetic", { REWIND_WINDOWS_SIGN_MODULE: "relative.cjs" }),
  ).toThrow("absolute");
});
it("binds the browser inventory to changed signed bytes and sanitizes signer failures", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rewind-synthetic-sign-"));
  try {
    const signer = path.join(root, "signer.cjs");
    writeFileSync(
      signer,
      "module.exports=async file=>require('node:fs').appendFileSync(file,'synthetic-signature');",
    );
    const file = path.join(root, "RewindBrowserHost.exe");
    writeFileSync(file, "synthetic-executable");
    writeFileSync(
      path.join(root, "assets.json"),
      JSON.stringify({
        version: 1,
        nativeSourceHash: "unchanged",
        native: { name: "RewindBrowserHost.exe" },
        extension: [],
      }),
    );
    vi.stubEnv("REWIND_WINDOWS_SIGN_MODULE", signer);
    const hook = createRequire(import.meta.url)(
      "../../scripts/sign-windows.cjs",
    ) as (file: string) => Promise<void>;
    expect(releaseSigning(path.resolve("apps/desktop"))?.hookModulePath).toBe(
      path.resolve("scripts/sign-windows.cjs"),
    );
    await hook(file);
    const inventory = JSON.parse(
      readFileSync(path.join(root, "assets.json"), "utf8"),
    );
    expect(inventory.native.sha256).toBe(
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    );
    expect(inventory.native.bytes).toBe(readFileSync(file).length);
    expect(inventory.nativeSourceHash).toBe("unchanged");
    const failed = path.join(root, "failed.cjs");
    writeFileSync(
      failed,
      "module.exports=async()=>{throw new Error('synthetic private signer data')}",
    );
    vi.stubEnv("REWIND_WINDOWS_SIGN_MODULE", failed);
    await expect(hook(file)).rejects.toThrow(/^WINDOWS_SIGNING_FAILED$/);
    const failedLoad = path.join(root, "failed-load.cjs");
    writeFileSync(
      failedLoad,
      "throw new Error('synthetic private module data')",
    );
    vi.stubEnv("REWIND_WINDOWS_SIGN_MODULE", failedLoad);
    await expect(hook(file)).rejects.toThrow(/^WINDOWS_SIGNING_FAILED$/);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
