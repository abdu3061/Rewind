import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, createServer, type ViteDevServer } from "vite";
import type { SecureStorage } from "@rewind/storage";
import {
  BrowserCollector,
  SessionCoordinator,
  SessionService,
} from "@rewind/engine";
import {
  createDefaultSettings,
  type ActivityEvent,
  type Result,
} from "@rewind/contracts";
import type { ExtensionSessionStatus } from "../../apps/browser-extension/src/native-session";
import {
  NativeBrowserBridge,
  nativeBridgeConfigSchema,
} from "../../apps/desktop/src/main/browser-bridge";
import { registerTestHost, removeBrowserFixture } from "./native-fixtures";

const ok = async (): Promise<Result<void>> => ({ ok: true, value: undefined });
const hash = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
interface ProbeSnapshot {
  status: ExtensionSessionStatus;
  reads: number;
}
for (const [browser, channel, executable] of [
  [
    "chrome",
    "chrome",
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
  ],
  [
    "edge",
    "msedge",
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
  ],
] as const) {
  test(`${browser} carries permissioned focused observations through the real native session and engine lifecycle`, async () => {
    test.skip(
      process.platform !== "win32" || !existsSync(executable),
      "Installed Windows browser required.",
    );
    const root = mkdtempSync(path.join(tmpdir(), "rewind-browser-e2e-")),
      nonce = randomUUID().replaceAll("-", "");
    const hostName = `com.rewind.test.${nonce}`,
      manifest = path.join(root, "native-host.json"),
      native = path.join(root, "SyntheticRewindHost.exe");
    let context: BrowserContext | null = null,
      bridge: NativeBrowserBridge | null = null,
      coordinator: SessionCoordinator | null = null;
    let sourceServer: ViteDevServer | null = null,
      actualStorage: SecureStorage | null = null;
    const storageKey = randomBytes(32),
      databaseFile = path.join(root, "browser-history.sqlite");
    let registered = false,
      bodyError: unknown,
      cleanupError: unknown;
    try {
      const compiler = path.join(
        process.env.WINDIR ?? "C:\\Windows",
        "Microsoft.NET",
        "Framework64",
        "v4.0.30319",
        "csc.exe",
      );
      execFileSync(
        compiler,
        [
          "/nologo",
          "/target:exe",
          "/platform:x64",
          "/r:System.Web.Extensions.dll",
          `/out:${native}`,
          path.resolve("apps/desktop/src/native/browser-process-proof.cs"),
          path.resolve("apps/desktop/src/native/browser-native-program.cs"),
        ],
        { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      );
      const extension = path.join(root, "extension"),
        entry = path.join(root, "entry.ts");
      mkdirSync(extension);
      writeFileSync(
        entry,
        `
import { ExtensionNativeSession } from ${JSON.stringify(path.resolve("apps/browser-extension/src/native-session.ts").replaceAll("\\", "/"))};
import { focusedBrowserTab } from ${JSON.stringify(path.resolve("apps/browser-extension/src/focused-tab-provider.ts").replaceAll("\\", "/"))};
let reads=0;
const access={lastFocusedWindow:()=>chrome.windows.getLastFocused({populate:false,windowTypes:["normal"]}),activeTabs:windowId=>chrome.tabs.query({active:true,windowId}),window:windowId=>chrome.windows.get(windowId,{populate:false})};
const session=new ExtensionNativeSession({profileId:crypto.randomUUID(),getFocusedTab:authorized=>{reads++;return focusedBrowserTab(access,authorized);},connect:()=>{
  const port=chrome.runtime.connectNative(${JSON.stringify(hostName)});
  return {postMessage:message=>port.postMessage(message),disconnect:()=>port.disconnect(),onMessage:listener=>{port.onMessage.addListener(listener);return()=>port.onMessage.removeListener(listener);},onDisconnect:listener=>{const callback=()=>{void chrome.runtime.lastError;listener();};port.onDisconnect.addListener(callback);return()=>port.onDisconnect.removeListener(callback);}};
}});
globalThis.probePermission=enabled=>session.permission(enabled);
globalThis.probeSnapshot=()=>({status:session.status(),reads});
globalThis.probeClose=()=>session.close();
chrome.runtime.onInstalled.addListener(()=>{});
`,
      );
      await build({
        configFile: false,
        publicDir: false,
        logLevel: "error",
        build: {
          target: "es2022",
          minify: false,
          outDir: extension,
          emptyOutDir: false,
          lib: { entry, formats: ["es"], fileName: () => "probe.js" },
        },
      });
      writeFileSync(
        path.join(extension, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Synthetic Rewind Native Session Probe",
          version: "1.0",
          permissions: ["tabs", "nativeMessaging"],
          incognito: "not_allowed",
          background: { service_worker: "probe.js", type: "module" },
        }),
      );
      context = await chromium.launchPersistentContext(
        path.join(root, `${browser}-profile`),
        {
          channel,
          headless: true,
          args: ["--enable-unsafe-extension-debugging"],
          ignoreDefaultArgs: ["--disable-extensions"],
        },
      );
      await context.route(
        /^http:\/\/(?:blocked\.)?rewind-fixture\.invalid\//,
        (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Synthetic native-session evidence</title><p>Synthetic page only.</p>",
          }),
      );
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(
        "http://rewind-fixture.invalid/first?token=synthetic#fragment",
      );
      await page.bringToFront();
      const instance = context.browser();
      if (!instance) throw new Error("SYNTHETIC_BROWSER_UNAVAILABLE");
      const cdp = await instance.newBrowserCDPSession();
      const loaded = await cdp.send("Extensions.loadUnpacked", {
        path: extension,
        enableInIncognito: false,
      });
      const worker =
        context
          .serviceWorkers()
          .find((item) =>
            item.url().startsWith(`chrome-extension://${loaded.id}/`),
          ) ??
        (await context.waitForEvent("serviceworker", {
          predicate: (item) =>
            item.url().startsWith(`chrome-extension://${loaded.id}/`),
        }));
      const snapshot = () =>
        worker.evaluate(() =>
          (
            globalThis as unknown as { probeSnapshot(): ProbeSnapshot }
          ).probeSnapshot(),
        );
      const clientPermission = (enabled: boolean) =>
        worker.evaluate(
          (value) =>
            (
              globalThis as unknown as {
                probePermission(
                  enabled: boolean,
                ): Promise<Result<ExtensionSessionStatus>>;
              }
            ).probePermission(value),
          enabled,
        );
      const config = nativeBridgeConfigSchema.parse({
        version: 1,
        pipeName: `rewind.session.test.${nonce}`,
        desktopPath: process.execPath,
        desktopHash: hash(process.execPath),
        hostHash: hash(native),
        origins: [`chrome-extension://${loaded.id}/`],
        browsers: [{ kind: browser, path: executable }],
      });
      writeFileSync(native + ".json", JSON.stringify(config));
      writeFileSync(
        manifest,
        JSON.stringify({
          name: hostName,
          description: "Temporary synthetic Rewind session test",
          path: native,
          type: "stdio",
          allowed_origins: config.origins,
        }),
      );
      bridge = new NativeBrowserBridge();
      const source = new BrowserCollector({ transport: bridge });
      // Load source workspaces and immutable raw SQL through Vite, just as the desktop/Vitest composition does.
      // This test server has no listening network endpoint and never receives captured metadata.
      sourceServer = await createServer({
        configFile: false,
        publicDir: false,
        logLevel: "error",
        cacheDir: path.join(root, "vite-cache"),
        server: { middlewareMode: true },
        appType: "custom",
      });
      const module = (await sourceServer.ssrLoadModule(
        "/packages/storage/src/secure-storage.ts",
      )) as { SecureStorage: typeof SecureStorage };
      const storage = new module.SecureStorage(databaseFile, storageKey);
      actualStorage = storage;
      const readEvents = async (): Promise<ActivityEvent[]> => {
        const result = await storage.timeline({
          limit: 100,
          types: ["browser-visit"],
        });
        if (!result.ok)
          throw new Error("SYNTHETIC_ENCRYPTED_BROWSER_HISTORY_UNAVAILABLE");
        return result.value;
      };
      let settings = createDefaultSettings(),
        windowsStarts = 0;
      coordinator = new SessionCoordinator({
        mode: "repository",
        storage,
        service: new SessionService({
          newId: randomUUID,
          now: () => new Date().toISOString(),
        }),
        collectors: {
          windows: {
            id: "windows",
            start: async () => {
              windowsStarts++;
              return ok();
            },
            resume: ok,
            pause: ok,
            stop: ok,
          },
          browser: source,
        },
        getSettings: () => settings,
        authorizeResource: async (event, policy) =>
          source.authorize(event, policy),
      });
      expect((await bridge.start(native, config)).ok).toBe(true);
      registerTestHost(browser, hostName, manifest, false);
      registered = true;
      expect((await snapshot()).reads).toBe(0);
      expect((await coordinator.execute("start")).ok).toBe(true);
      expect((await clientPermission(true)).ok).toBe(true);
      await expect
        .poll(async () => (await snapshot()).status.connected, {
          timeout: 10000,
        })
        .toBe(true);
      expect((await snapshot()).reads).toBe(0);
      expect(await readEvents()).toEqual([]);
      const approved = {
        ...settings,
        browserCollectionConsent: true,
        excludedSiteHosts: ["blocked.rewind-fixture.invalid"],
      };
      expect(
        (
          await coordinator.updateSettings(approved, async () => {
            const saved = await storage.saveSettings(approved);
            if (saved.ok) settings = approved;
            return saved;
          })
        ).ok,
      ).toBe(true);
      expect((await coordinator.execute("resume")).ok).toBe(true);
      const generation = coordinator.getActiveGenerationId();
      await expect
        .poll(() => source.status().captured, { timeout: 10000 })
        .toBe(1);
      expect(windowsStarts).toBe(0);
      expect(await readEvents()).toEqual([
        expect.objectContaining({
          type: "browser-visit",
          source: "browser",
          payload: expect.objectContaining({
            browser,
            url: "http://rewind-fixture.invalid/first",
            title: "Synthetic native-session evidence",
            endedAt: null,
          }),
        }),
      ]);
      await page.goto("http://blocked.rewind-fixture.invalid/excluded");
      await page.bringToFront();
      const beforeExcluded = (await snapshot()).reads;
      await expect
        .poll(async () => (await snapshot()).reads, { timeout: 5000 })
        .toBeGreaterThan(beforeExcluded);
      expect(await readEvents()).toHaveLength(1);
      expect((await coordinator.execute("pause")).ok).toBe(true);
      const beforePaused = (await snapshot()).reads;
      await page.goto(
        "http://rewind-fixture.invalid/second?secret=synthetic#fragment",
      );
      await page.bringToFront();
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect((await snapshot()).reads).toBe(beforePaused);
      expect(await readEvents()).toHaveLength(1);
      expect((await coordinator.execute("resume")).ok).toBe(true);
      expect(coordinator.getActiveGenerationId()).not.toBe(generation);
      await expect
        .poll(async () => (await readEvents()).length, { timeout: 10000 })
        .toBe(2);
      expect((await readEvents())[0]).toMatchObject({
        type: "browser-visit",
        payload: { browser, url: "http://rewind-fixture.invalid/second" },
      });
      expect((await coordinator.execute("end")).ok).toBe(true);
      expect((await snapshot()).status).toMatchObject({
        permission: true,
        connected: true,
        collecting: false,
        pending: false,
      });
      const search = await storage.timeline({
        limit: 10,
        text: "native-session",
        types: ["browser-visit"],
      });
      expect(search.ok && search.value).toHaveLength(2);
      expect(
        await storage.timeline({
          limit: 10,
          text: "excluded",
          types: ["browser-visit"],
        }),
      ).toEqual({ ok: true, value: [] });
      // A separate client revocation is an acknowledged permission gap, not an invented native disconnect.
      expect((await coordinator.execute("start")).ok).toBe(true);
      await expect
        .poll(async () => (await readEvents()).length, { timeout: 10000 })
        .toBe(3);
      expect((await clientPermission(false)).ok).toBe(true);
      await expect
        .poll(() => coordinator!.getStatus().unavailable, { timeout: 5000 })
        .toBe(true);
      expect(
        await storage.timeline({ limit: 10, types: ["capture-gap"] }),
      ).toMatchObject({
        ok: true,
        value: [
          expect.objectContaining({
            type: "capture-gap",
            payload: { collectorId: "browser", reason: "permission-denied" },
          }),
        ],
      });
      expect((await snapshot()).status).toMatchObject({
        permission: false,
        connected: true,
        collecting: false,
        pending: false,
      });
      expect((await coordinator.execute("end")).ok).toBe(true);
      expect(readFileSync(databaseFile).subarray(0, 16).toString()).not.toBe(
        "SQLite format 3\0",
      );
      // Inspect the live WAL as well as the database, before close/checkpoint can remove it.
      expect(readdirSync(root)).toContain("browser-history.sqlite-wal");
      for (const name of readdirSync(root).filter((name) =>
        name.startsWith("browser-history.sqlite"),
      )) {
        const bytes = readFileSync(path.join(root, name));
        for (const marker of [
          "Synthetic native-session evidence",
          "rewind-fixture.invalid/first",
          "rewind-fixture.invalid/second",
        ]) {
          expect(bytes.includes(Buffer.from(marker))).toBe(false);
          expect(bytes.includes(Buffer.from(marker, "utf16le"))).toBe(false);
        }
      }
      expect((await coordinator.shutdown()).ok).toBe(true);
      coordinator = null;
      const reopened = new module.SecureStorage(databaseFile, storageKey);
      actualStorage = reopened;
      expect((await reopened.open()).ok).toBe(true);
      const retained = await reopened.timeline({
        limit: 10,
        text: "native-session",
        types: ["browser-visit"],
      });
      expect(retained.ok && retained.value).toHaveLength(3);
      expect((await reopened.close()).ok).toBe(true);
      expect((await bridge.close()).ok).toBe(true);
      await expect
        .poll(async () => (await snapshot()).status.permission, {
          timeout: 5000,
        })
        .toBe(false);
      const ended = await snapshot();
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect((await snapshot()).reads).toBe(ended.reads);
    } catch (error) {
      bodyError = error;
    } finally {
      try {
        if (coordinator && !(await coordinator.shutdown()).ok)
          cleanupError ??= new Error("SYNTHETIC_SESSION_SHUTDOWN_UNCONFIRMED");
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (bridge && !(await bridge.close()).ok)
          cleanupError ??= new Error("SYNTHETIC_BRIDGE_EXIT_UNCONFIRMED");
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (context) await context.close();
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (actualStorage && !(await actualStorage.close()).ok)
          cleanupError ??= new Error(
            "SYNTHETIC_ENCRYPTED_STORE_CLOSE_UNCONFIRMED",
          );
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (sourceServer) await sourceServer.close();
      } catch (error) {
        cleanupError ??= error;
      }
      storageKey.fill(0);
      try {
        if (registered) registerTestHost(browser, hostName, manifest, true);
      } catch (error) {
        cleanupError ??= error;
      }
      if (!cleanupError) {
        try {
          removeBrowserFixture(root);
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (bodyError && cleanupError)
      throw new AggregateError(
        [bodyError, cleanupError],
        "Synthetic native session and cleanup failed.",
      );
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  });
}
