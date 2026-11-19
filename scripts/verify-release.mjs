import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { getCurrentFuseWire, FuseV1Options, FuseState } from "@electron/fuses";

const require = createRequire(import.meta.url);
const { extractFile, listPackage } = require("@electron/asar");
const yauzl = require("yauzl");
const root = path.resolve("apps/desktop/out/Rewind-win32-x64");
const executable = path.join(root, "Rewind.exe");
const resources = path.join(root, "resources");
const archive = path.join(resources, "app.asar");
const buildReceipt = JSON.parse(
  await readFile(path.join(resources, "release/build.json"), "utf8"),
);
assert.equal(buildReceipt.format, 1);
assert.equal(
  buildReceipt.dirty,
  false,
  "Final artifacts must be built from committed source",
);
assert.equal(
  buildReceipt.mode,
  "release",
  "Expected final release build provenance",
);
assert.match(buildReceipt.source, /^[a-f0-9]{40}$/);
assert.match(buildReceipt.lockSha256, /^[a-f0-9]{64}$/);
async function hash(file) {
  const value = createHash("sha256");
  for await (const bytes of createReadStream(file)) value.update(bytes);
  return value.digest("hex");
}

const fuses = await getCurrentFuseWire(executable);
for (const name of [
  "RunAsNode",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "GrantFileProtocolExtraPrivileges",
])
  assert.equal(
    fuses[FuseV1Options[name]],
    FuseState.DISABLE,
    `Release fuse must be disabled: ${name}`,
  );
for (const name of [
  "EnableCookieEncryption",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
])
  assert.equal(
    fuses[FuseV1Options[name]],
    FuseState.ENABLE,
    `Release fuse must be enabled: ${name}`,
  );
const manifest = JSON.parse(extractFile(archive, "package.json").toString());
assert.equal(manifest.productName, "Rewind");
for (const entry of [
  "main.cjs",
  "worker-entry.cjs",
  "document-entry.cjs",
  "preload.cjs",
])
  assert.ok(extractFile(archive, `.vite/build/${entry}`).length > 100);
assert.ok(
  listPackage(archive).every(
    (file) => !/(^|[\\/])(\.env[^\\/]*|synthetic-fixture\.json)$/.test(file),
  ),
);
for (const file of [
  "LICENSE",
  "LICENSES.chromium.html",
  "resources/rewind.png",
  "resources/documents/RewindDocumentGuard.exe",
  "resources/app.asar.unpacked/node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node",
])
  assert.ok(
    (await stat(path.join(root, file))).size > 0,
    `Missing release asset: ${file}`,
  );
const browser = JSON.parse(
  await readFile(path.join(resources, "browser/assets.json"), "utf8"),
);
assert.equal(
  await hash(path.join(resources, "browser/RewindBrowserHost.exe")),
  browser.native.sha256,
);
for (const entry of browser.extension)
  assert.equal(
    await hash(path.join(resources, "browser/extension", entry.name)),
    entry.sha256,
  );
const notices = JSON.parse(
  await readFile(path.join(resources, "notices/inventory.json"), "utf8"),
);
for (const item of notices.packages)
  for (const notice of item.notices)
    assert.equal(
      await hash(
        path.join(
          resources,
          "notices/packages",
          `${item.name}@${item.version}`.replaceAll("/", "__"),
          notice.file,
        ),
      ),
      notice.sha256,
    );

const make = path.resolve("apps/desktop/out/make");
const zipDirectory = path.join(make, "zip/win32/x64");
const zip = (await readdir(zipDirectory)).filter((name) =>
  name.endsWith(`-${manifest.version}.zip`),
);
assert.equal(zip.length, 1, "Expected exactly one versioned Windows ZIP");
const files = [
  path.join(zipDirectory, zip[0]),
  path.join(make, "squirrel.windows/x64/Rewind-Setup.exe"),
  path.join(make, `squirrel.windows/x64/Rewind-${manifest.version}-full.nupkg`),
  path.join(make, "squirrel.windows/x64/RELEASES"),
];

// Verify both distributions contain the same executable, ASAR and inventory tested here.
const expected = new Map(
  await Promise.all(
    [
      "Rewind.exe",
      "resources/app.asar",
      "resources/browser/assets.json",
      "resources/notices/inventory.json",
      "resources/release/build.json",
    ].map(async (name) => [
      name,
      {
        bytes: (await stat(path.join(root, name))).size,
        hash: await hash(path.join(root, name)),
      },
    ]),
  ),
);
async function inspectZip(file) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const seen = new Set();
  await new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry) => {
      const name = entry.fileName.replace(/^lib\/net45\//, "");
      const target = expected.get(name);
      if (!target) {
        zip.readEntry();
        return;
      }
      if (seen.has(name) || entry.uncompressedSize !== target.bytes) {
        zip.close();
        reject(new Error("RELEASE_ARCHIVE_ENTRY_INVALID"));
        return;
      }
      seen.add(name);
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        const value = createHash("sha256");
        stream.on("error", reject);
        stream.on("data", (chunk) => value.update(chunk));
        stream.on("end", () => {
          if (value.digest("hex") !== target.hash) {
            zip.close();
            reject(new Error("RELEASE_ARCHIVE_HASH_MISMATCH"));
            return;
          }
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  assert.equal(
    seen.size,
    expected.size,
    "Distribution is missing verified runtime assets",
  );
}
await inspectZip(files[0]);
await inspectZip(files[2]);

// Actual hardened binary: marked temporary profile only, no main-process inspector.
const profile = await mkdtemp(path.join(tmpdir(), "rewind-e2e-"));
let child,
  exited = false;
let startupMs;
let mainMemory;
try {
  await writeFile(
    path.join(profile, "synthetic-fixture.json"),
    JSON.stringify({ format: 1, synthetic: true }),
  );
  const injection = path.join(profile, "synthetic-injection.cjs");
  const marker = path.join(profile, "injection-ran");
  await writeFile(
    injection,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`,
  );
  child = spawn(
    executable,
    [`--rewind-fixture-root=${profile}`, "--inspect=127.0.0.1:0"],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        APPDATA: profile,
        LOCALAPPDATA: profile,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: `--require "${injection}"`,
      },
    },
  );
  let inspector = false;
  child.stderr.on("data", (bytes) => {
    inspector ||= bytes.toString().includes("Debugger listening");
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      exited = true;
      resolve(code);
    });
  });
  const logPath = path.join(profile, "logs/operations.jsonl");
  const started = Date.now();
  while (true) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    if (log.includes('"DESKTOP_READY"')) break;
    assert.ok(
      !exited && Date.now() - started < 20000,
      "Hardened desktop startup failed",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  startupMs = Date.now() - started;
  assert.equal(
    (await readFile(logPath, "utf8")).includes('"SERVICE_UNAVAILABLE"'),
    false,
    "Encrypted service was unavailable in hardened startup",
  );
  const memory = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-Process -Id ${child.pid}; @{workingSetBytes=$process.WorkingSet64; privateBytes=$process.PrivateMemorySize64} | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, timeout: 5000 },
  );
  mainMemory = JSON.parse(memory.stdout);
  assert.equal(
    await stat(marker).then(
      () => true,
      () => false,
    ),
    false,
    "NODE_OPTIONS was executed",
  );
  assert.equal(inspector, false, "Main-process inspector was enabled");
  await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-Process -Id ${child.pid}; if (-not $process.CloseMainWindow()) { exit 1 }`,
    ],
    { windowsHide: true, timeout: 5000 },
  );
  const code = await Promise.race([
    closed,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("HARDENED_SHUTDOWN_TIMEOUT")),
        15000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(code, 0);
  assert.ok((await readFile(logPath, "utf8")).includes('"DESKTOP_STOPPED"'));
} finally {
  if (child && !exited) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill();
    await closed;
  }
  const relative = path.relative(tmpdir(), profile);
  assert.ok(
    relative.startsWith("rewind-e2e-") &&
      !relative.includes(path.sep) &&
      !path.isAbsolute(relative),
  );
  await rm(profile, { recursive: true, force: true });
}
const artifacts = await Promise.all(
  files.map(async (file) => ({
    file: path.relative(make, file).replaceAll(path.sep, "/"),
    bytes: (await stat(file)).size,
    sha256: await hash(file),
  })),
);
await writeFile(
  path.join(make, "release-manifest.json"),
  `${JSON.stringify({ format: 1, version: manifest.version, target: "win32-x64", build: buildReceipt, signedAcceptance: "manual verification required", runtimeNotices: notices.packages.length, syntheticStartup: { readyMs: startupMs, mainProcessOnly: mainMemory }, artifacts }, null, 2)}\n`,
);
console.log(
  `Verified hardened Windows startup/shutdown, both distribution payloads, native inventories and ${notices.packages.length} dependency notice entries. Release manifest written. Authenticode/installation/live Gemini acceptance remain manual.`,
);
