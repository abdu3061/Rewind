/* eslint-disable @typescript-eslint/no-require-imports -- Forge/Squirrel require a CommonJS signing hook. */
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Build-time only. Do not place credentials in this repository or log signer errors.
module.exports = async function signWindows(file) {
  const modulePath = process.env.REWIND_WINDOWS_SIGN_MODULE;
  if (!modulePath || !path.isAbsolute(modulePath))
    throw new Error("WINDOWS_SIGNER_REQUIRED");
  try {
    const signer = require(modulePath);
    if (typeof signer !== "function") throw new Error("WINDOWS_SIGNER_INVALID");
    await signer(file);
  } catch {
    throw new Error("WINDOWS_SIGNING_FAILED");
  }
  // Authenticode changes executable bytes. Bind the native inventory to signed bytes
  // before either Forge or Squirrel archives them; never bypass runtime verification.
  if (path.basename(file) === "RewindBrowserHost.exe") {
    const inventoryPath = path.join(path.dirname(file), "assets.json");
    const inventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
    if (
      inventory.version !== 1 ||
      inventory.native?.name !== "RewindBrowserHost.exe"
    )
      throw new Error("SIGNED_BROWSER_INVENTORY_INVALID");
    const bytes = await fs.readFile(file);
    inventory.native.bytes = bytes.length;
    inventory.native.sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(
      inventoryPath,
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
  }
};
