import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createBrowserSetupJournal } from "@rewind/contracts";
import { SecureStorage } from "@rewind/storage";
import { generateBrowserAssets } from "../../browser-assets";
import {
  readBrowserAssets,
  type VerifiedBrowserAssets,
} from "./browser-assets";
import { BrowserInstallationFiles } from "./browser-installation-files";
import { NativeBrowserBridge } from "./browser-bridge";
import { BrowserSetupManager } from "./browser-setup-manager";
import { NativeBrowserRegistration } from "./browser-registration";
import { registerTestHost } from "../../../../tests/browser/native-fixtures";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

let assetRoot: string,
  root: string,
  profile: string,
  assets: VerifiedBrowserAssets,
  desktop: { path: string; hash: string };
let preserveRoot = false;
const browsers = [
  { kind: "chrome" as const, path: "C:\\SyntheticBrowserFixture\\chrome.exe" },
];
beforeAll(async () => {
  if (process.platform !== "win32") return;
  assetRoot = newSecureFixture();
  await generateBrowserAssets(
    path.resolve("apps/desktop"),
    "win32",
    "x64",
    path.join(assetRoot, "browser"),
  );
  const loaded = await readBrowserAssets(path.join(assetRoot, "browser"));
  if (!loaded.ok) throw new Error("SYNTHETIC_ASSETS_UNAVAILABLE");
  assets = loaded.value;
  desktop = {
    path: process.execPath,
    hash: createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex"),
  };
}, 20000);
beforeEach(async () => {
  if (process.platform !== "win32") return;
  root = newSecureFixture();
  preserveRoot = false;
  profile = path.join(root, "profile");
  await mkdir(profile);
  await writeFile(
    path.join(profile, "synthetic-fixture.json"),
    JSON.stringify({ format: 1, synthetic: true }),
  );
});
afterEach(() => {
  if (root && !preserveRoot) {
    removeSecureFixture(root);
    root = "";
  }
});
afterAll(() => {
  if (assetRoot) removeSecureFixture(assetRoot);
});

it.skipIf(process.platform !== "win32")(
  "publishes verified new files, retains encrypted native receipts across restart and starts/stops the actual passive broker",
  async () => {
    const publisher = new BrowserInstallationFiles(profile);
    const published = await publisher.publish(assets, desktop, browsers);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const value = published.value;
    expect(await readdir(path.dirname(value.executable))).toEqual(
      expect.arrayContaining([
        "RewindBrowserHost.exe",
        "RewindBrowserHost.exe.json",
        "native-host.json",
      ]),
    );
    expect(value.generation.native.contentHash).toBe(
      assets.inventory.native.sha256,
    );
    expect(value.generation.configuration.osIdentity).not.toBe(
      value.generation.manifest.osIdentity,
    );
    expect(await publisher.verify(value.generation)).toEqual(published);
    const key = randomBytes(32),
      file = path.join(profile, "history.sqlite");
    const first = new SecureStorage(file, key),
      second = new SecureStorage(file, key);
    const bridge = new NativeBrowserBridge();
    bridge.setListener({
      connected() {},
      message() {},
      disconnected() {},
      unavailable() {},
    });
    try {
      expect((await first.open()).ok).toBe(true);
      expect(
        (
          await first.browserSetup.write(0, {
            ...createBrowserSetupJournal(),
            revision: 1,
            generations: [value.generation],
            pending: {
              operation: "install",
              generationId: value.generation.id,
              browsers: ["chrome"],
              previous: { chrome: null, edge: null },
            },
          })
        ).ok,
      ).toBe(true);
      expect((await first.close()).ok).toBe(true);
      expect((await second.open()).ok).toBe(true);
      const retained = await second.browserSetup.read();
      expect(retained.ok).toBe(true);
      if (!retained.ok) return;
      expect(await publisher.verify(retained.value.generations[0]!)).toEqual(
        published,
      );
      expect(
        (await bridge.start(value.executable, value.configuration)).ok,
      ).toBe(true);
      expect(bridge.status()).toEqual({ state: "ready", connected: 0 });
      expect((await bridge.close()).ok).toBe(true);
      expect(await second.getSettings()).toMatchObject({
        ok: true,
        value: { browserCollectionConsent: false },
      });
    } finally {
      expect((await bridge.close()).ok).toBe(true);
      await first.close();
      await second.close();
      key.fill(0);
    }
  },
  30000,
);

it.skipIf(process.platform !== "win32")(
  "detects changed configuration, replacement with identical bytes, and untracked files without modifying originals",
  async () => {
    const publisher = new BrowserInstallationFiles(profile),
      published = await publisher.publish(assets, desktop, browsers);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const config = `${published.value.executable}.json`,
      original = await readFile(config);
    await writeFile(config, Buffer.concat([original, Buffer.from(" ")]));
    expect((await publisher.verify(published.value.generation)).ok).toBe(false);
    await writeFile(config, original);
    expect((await publisher.verify(published.value.generation)).ok).toBe(true);
    await rename(config, path.join(root, "original-configuration.json"));
    await writeFile(config, original);
    expect((await publisher.verify(published.value.generation)).ok).toBe(false);
    await rename(config, path.join(root, "replacement-configuration.json"));
    await rename(path.join(root, "original-configuration.json"), config);
    expect((await publisher.verify(published.value.generation)).ok).toBe(true);
    const untracked = path.join(path.dirname(config), "untracked-fixture.json");
    await writeFile(untracked, "{}");
    expect((await publisher.verify(published.value.generation)).ok).toBe(false);
    expect(await readFile(config)).toEqual(original);
  },
  30000,
);

it.skipIf(process.platform !== "win32")(
  "rejects redirected installation directories and preserves the redirected target",
  async () => {
    const target = path.join(root, "synthetic-redirected-target");
    await mkdir(target);
    await symlink(target, path.join(profile, "browser-host"), "junction");
    expect(
      (
        await new BrowserInstallationFiles(profile).publish(
          assets,
          desktop,
          browsers,
        )
      ).ok,
    ).toBe(false);
    expect(await readdir(target)).toEqual([]);
  },
);

it.skipIf(process.platform !== "win32")(
  "rejects altered assets and invalid desktop configuration before creating installation directories",
  async () => {
    const publisher = new BrowserInstallationFiles(profile);
    const modified = Buffer.from(assets.native);
    modified[0] = modified[0]! ^ 1;
    expect(
      (
        await publisher.publish(
          { ...assets, native: modified },
          desktop,
          browsers,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await publisher.publish(
          assets,
          { ...desktop, path: "relative.exe" },
          browsers,
        )
      ).ok,
    ).toBe(false);
    expect(await readdir(profile)).toEqual(["synthetic-fixture.json"]);
  },
);
it.skipIf(process.platform !== "win32")(
  "rejects a replaced generation redirected to identical original files",
  async () => {
    const publisher = new BrowserInstallationFiles(profile),
      published = await publisher.publish(assets, desktop, browsers);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const directory = path.dirname(published.value.executable),
      saved = path.join(root, "saved-native-generation");
    await rename(directory, saved);
    await symlink(saved, directory, "junction");
    expect((await publisher.verify(published.value.generation)).ok).toBe(false);
    expect(await readFile(path.join(saved, "RewindBrowserHost.exe"))).toEqual(
      assets.native,
    );
  },
  30000,
);
it.skipIf(process.platform !== "win32")(
  "journals real published receipts before temporary native registration and removes it after observed broker shutdown",
  async () => {
    const key = randomBytes(32),
      storage = new SecureStorage(path.join(profile, "history.sqlite"), key);
    const name = `com.rewind.test.${randomUUID().replaceAll("-", "")}`;
    const fixtureAssetsRoot = path.join(profile, "browser-assets");
    await generateBrowserAssets(
      path.resolve("apps/desktop"),
      "win32",
      "x64",
      fixtureAssetsRoot,
      name,
    );
    const fixtureAssets = await readBrowserAssets(fixtureAssetsRoot, name);
    if (!fixtureAssets.ok) throw new Error("SYNTHETIC_TEST_ASSET_UNAVAILABLE");
    const helper = path.join(fixtureAssetsRoot, "RewindBrowserHost.exe");
    const registry = new NativeBrowserRegistration(helper, name),
      publisher = new BrowserInstallationFiles(profile, name),
      bridge = new NativeBrowserBridge();
    bridge.setListener({
      connected() {},
      message() {},
      disconnected() {},
      unavailable() {},
    });
    let manager: BrowserSetupManager | null = null,
      manifest = path.join(profile, "unregistered-synthetic.json");
    let bodyError: unknown, cleanupError: unknown;
    try {
      expect((await storage.open()).ok).toBe(true);
      manager = new BrowserSetupManager({
        store: storage.browserSetup,
        files: publisher,
        registry,
        assets: async () => fixtureAssets,
        desktop: async () => ({ ok: true, value: desktop }),
        browsers,
        quiesce: () => bridge.close(),
      });
      const installed = await manager.install(true, ["chrome"]);
      const journal = await storage.browserSetup.read();
      if (journal.ok && journal.value.generations[0])
        manifest = publisher.location(journal.value.generations[0]).manifest;
      expect(installed.ok).toBe(true);
      const loaded = await manager.load();
      expect(loaded.ok && loaded.value).toBeTruthy();
      if (!loaded.ok || !loaded.value)
        throw new Error("SYNTHETIC_INSTALLATION_MISSING");
      manifest = loaded.value.manifest;
      expect(await registry.inspect("chrome", manifest)).toMatchObject({
        ok: true,
        value: { state: "registered", registeredViews: 2 },
      });
      expect(
        (
          await bridge.start(
            loaded.value.executable,
            loaded.value.configuration,
          )
        ).ok,
      ).toBe(true);
      expect(bridge.status()).toEqual({ state: "ready", connected: 0 });
      expect((await manager.remove(true, "chrome")).ok).toBe(true);
      expect(bridge.status().connected).toBe(0);
      expect(await manager.load()).toEqual({ ok: true, value: null });
      expect(await registry.inspect("chrome", manifest)).toMatchObject({
        ok: true,
        value: { state: "absent" },
      });
      expect(await storage.getSettings()).toMatchObject({
        ok: true,
        value: { browserCollectionConsent: false },
      });
    } catch (error) {
      bodyError = error;
    } finally {
      try {
        if (manager && !(await manager.close()).ok)
          cleanupError ??= new Error("SYNTHETIC_SETUP_CLOSE_UNCONFIRMED");
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (!(await bridge.close()).ok)
          cleanupError ??= new Error("SYNTHETIC_BROKER_CLOSE_UNCONFIRMED");
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await registerTestHost("chrome", name, manifest, true, helper);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (!(await storage.close()).ok)
          cleanupError ??= new Error("SYNTHETIC_STORE_CLOSE_UNCONFIRMED");
      } catch (error) {
        cleanupError ??= error;
      }
      key.fill(0);
      if (cleanupError) preserveRoot = true;
    }
    if (bodyError && cleanupError)
      throw new AggregateError(
        [bodyError, cleanupError],
        "Synthetic setup and cleanup failed; preserved files.",
      );
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  },
  30000,
);
it.skipIf(process.platform !== "win32")(
  "waits for active publication before acknowledging close and rejects new work afterward",
  async () => {
    const publisher = new BrowserInstallationFiles(profile),
      publishing = publisher.publish(assets, desktop, browsers);
    let stopped = false;
    const closing = publisher.close().then((result) => {
      stopped = true;
      return result;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const published = await publishing;
    expect(published.ok).toBe(true);
    expect((await closing).ok).toBe(true);
    if (published.ok)
      expect((await publisher.verify(published.value.generation)).ok).toBe(
        false,
      );
    expect((await publisher.publish(assets, desktop, browsers)).ok).toBe(false);
  },
  30000,
);
