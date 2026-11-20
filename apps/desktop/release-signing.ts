import { existsSync } from "node:fs";
import path from "node:path";

/** Owner's external CJS signer may use Windows certificate stores, a token or HSM. */
export function releaseSigning(
  desktopDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const signer = env.REWIND_WINDOWS_SIGN_MODULE;
  if (!signer) {
    if (env.REWIND_REQUIRE_SIGNING === "1")
      throw new Error("Release signing is required but not configured.");
    return undefined;
  }
  if (!path.isAbsolute(signer) || !existsSync(signer))
    throw new Error("An absolute external release signer module is required.");
  return {
    hookModulePath: path.resolve(
      desktopDirectory,
      "../../scripts/sign-windows.cjs",
    ),
  };
}
