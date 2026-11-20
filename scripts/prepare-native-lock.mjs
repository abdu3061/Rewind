import { readFileSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import process from "node:process";

// npm omits this upstream manifest field from lock metadata and otherwise synthesizes
// a source build on npm ci merely because the archive also contains binding.gyp.
const filename = new URL("../package-lock.json", import.meta.url);
const lock = JSON.parse(readFileSync(filename, "utf8"));
const dependency =
  lock.packages["node_modules/better-sqlite3-multiple-ciphers"];
if (
  dependency?.version !== "13.1.1" ||
  dependency.resolved !==
    "https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-13.1.1.tgz"
) {
  throw new Error(
    "Review the encrypted native dependency before changing install metadata.",
  );
}
if (process.argv.includes("--check")) {
  if (dependency.gypfile !== false)
    throw new Error(
      "Run npm run lock:prepare after regenerating the lockfile; the reviewed native runtime uses prebuilds.",
    );
} else {
  dependency.gypfile = false;
  writeFileSync(filename, JSON.stringify(lock, null, 2) + "\n");
}
