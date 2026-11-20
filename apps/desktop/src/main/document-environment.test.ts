import { afterEach, expect, it, vi } from "vitest";
import { documentEnvironment } from "./document-environment";

afterEach(() => vi.unstubAllEnvs());
it("passes only Windows runtime locations and disables canvas system-font discovery", () => {
  vi.stubEnv("GEMINI_API_KEY", "synthetic-key-do-not-inherit");
  vi.stubEnv("NODE_OPTIONS", "--require=C:\\synthetic-injection.js");
  vi.stubEnv("NODE_PATH", "C:\\synthetic-modules");
  vi.stubEnv("NAPI_RS_NATIVE_LIBRARY_PATH", "C:\\synthetic-binding.node");
  vi.stubEnv("NAPI_RS_FORCE_WASI", "1");
  const env = documentEnvironment();
  expect(Object.keys(env).sort()).toEqual([
    "DISABLE_SYSTEM_FONTS_LOAD",
    "SystemRoot",
    "WINDIR",
  ]);
  expect(env.DISABLE_SYSTEM_FONTS_LOAD).toBe("1");
});
