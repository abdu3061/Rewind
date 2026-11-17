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
import {
  extensionResponseSchema,
  type ExtensionStatus,
} from "../../apps/browser-extension/src/extension-controls";
import {
  NativeBrowserBridge,
  nativeBridgeConfigSchema,
} from "../../apps/desktop/src/main/browser-bridge";
import { registerTestHost, removeBrowserFixture } from "./native-fixtures";

const ok = async (): Promise<Result<void>> => ({ ok: true, value: undefined });
const hash = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
interface ProbeSnapshot {
  status: ExtensionStatus;
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
          path.resolve("apps/desktop/src/native/browser-registration.cs"),
        ],
        { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      );
      const extension = path.join(root, "extension"),
        entry = path.join(root, "entry.ts");
      mkdirSync(extension);
      // Test-only call counters wrap APIs before loading the unchanged normal background entry.
      writeFileSync(
        path.join(root, "instrumentation.ts"),
        `
let calls=0;
for(const [area,name] of [[chrome.windows,"getLastFocused"],[chrome.windows,"get"],[chrome.tabs,"query"]]) {
  const original=area[name].bind(area);area[name]=(...args)=>{calls++;return original(...args);};
}
globalThis.probeReadCount=()=>calls;
globalThis.probeInstanceId=crypto.randomUUID();
`,
      );
      writeFileSync(
        entry,
        `import "./instrumentation.ts";\nimport ${JSON.stringify(path.resolve("apps/browser-extension/src/background.ts").replaceAll("\\", "/"))};\n`,
      );
      await build({
        configFile: path.resolve("apps/browser-extension/vite.config.ts"),
        root: path.resolve("apps/browser-extension"),
        define: { __REWIND_NATIVE_HOST_NAME__: JSON.stringify(hostName) },
        logLevel: "error",
        build: {
          target: "es2022",
          minify: false,
          outDir: extension,
          emptyOutDir: false,
          lib: {
            entry: {
              background: entry,
              popup: path.resolve("apps/browser-extension/src/popup.ts"),
            },
            formats: ["es"],
            fileName: (_format, name) => `${name}.js`,
          },
        },
      });
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
      const manifestKey = (
        JSON.parse(
          readFileSync(path.join(extension, "manifest.json"), "utf8"),
        ) as { key: string }
      ).key;
      const expectedId = createHash("sha256")
        .update(Buffer.from(manifestKey, "base64"))
        .digest("hex")
        .slice(0, 32)
        .replace(/[0-9a-f]/g, (value) =>
          String.fromCharCode(97 + parseInt(value, 16)),
        );
      expect(loaded.id).toBe(expectedId);
      let worker =
        context
          .serviceWorkers()
          .find((item) =>
            item.url().startsWith(`chrome-extension://${loaded.id}/`),
          ) ??
        (await context.waitForEvent("serviceworker", {
          predicate: (item) =>
            item.url().startsWith(`chrome-extension://${loaded.id}/`),
        }));
      let controls = await context.newPage();
      await controls.goto(`chrome-extension://${loaded.id}/status.html`);
      await worker.evaluate(() =>
        (
          globalThis as unknown as {
            chrome: { action: { openPopup(): Promise<void> } };
          }
        ).chrome.action.openPopup(),
      );
      await expect
        .poll(() =>
          controls.evaluate(
            () =>
              (
                globalThis as unknown as {
                  chrome: {
                    extension: { getViews(input: { type: string }): Window[] };
                  };
                }
              ).chrome.extension
                .getViews({ type: "popup" })[0]
                ?.document.querySelector("#status")?.textContent,
          ),
        )
        .toBe("Recording is off.");
      await controls.bringToFront();
      const snapshot = async (): Promise<ProbeSnapshot> => {
        const result = extensionResponseSchema.parse(
          await controls.evaluate(() =>
            (
              globalThis as unknown as {
                chrome: {
                  runtime: { sendMessage(input: unknown): Promise<unknown> };
                };
              }
            ).chrome.runtime.sendMessage({ kind: "rewind.browser.status" }),
          ),
        );
        if (!result.ok)
          throw new Error("SYNTHETIC_EXTENSION_CONTROLS_UNAVAILABLE");
        return {
          status: result.value,
          reads: await worker.evaluate(() =>
            (
              globalThis as unknown as { probeReadCount(): number }
            ).probeReadCount(),
          ),
        };
      };
      const clientPermission = async (enabled: boolean): Promise<void> => {
        await worker.evaluate(() =>
          (
            globalThis as unknown as {
              chrome: { action: { openPopup(): Promise<void> } };
            }
          ).chrome.action.openPopup(),
        );
        await expect
          .poll(() =>
            controls.evaluate(
              (expected) => {
                const popup = (
                  globalThis as unknown as {
                    chrome: {
                      extension: {
                        getViews(input: { type: string }): Window[];
                      };
                    };
                  }
                ).chrome.extension.getViews({ type: "popup" })[0];
                const button =
                  popup?.document.querySelector<HTMLButtonElement>(
                    "#permission",
                  );
                return (
                  !!button &&
                  !button.disabled &&
                  button.textContent === expected
                );
              },
              enabled ? "Allow and connect" : "Stop recording",
            ),
          )
          .toBe(true);
        await controls.evaluate(() => {
          const popup = (
            globalThis as unknown as {
              chrome: {
                extension: { getViews(input: { type: string }): Window[] };
              };
            }
          ).chrome.extension.getViews({ type: "popup" })[0];
          popup!.document
            .querySelector<HTMLButtonElement>("#permission")!
            .click();
        });
        await expect
          .poll(
            async () => {
              const status = (await snapshot()).status;
              return status.permission === enabled && !status.pending;
            },
            {
              timeout: 10000,
            },
          )
          .toBe(true);
        await controls.evaluate(() =>
          (
            globalThis as unknown as {
              chrome: {
                extension: { getViews(input: { type: string }): Window[] };
              };
            }
          ).chrome.extension
            .getViews({ type: "popup" })[0]
            ?.close(),
        );
      };
      const unauthorized = await context.newPage();
      await unauthorized.goto(
        `chrome-extension://${loaded.id}/status.html?synthetic-untrusted-view=1`,
      );
      expect(
        await unauthorized.evaluate(() =>
          (
            globalThis as unknown as {
              chrome: {
                runtime: { sendMessage(input: unknown): Promise<unknown> };
              };
            }
          ).chrome.runtime.sendMessage({
            kind: "rewind.browser.permission",
            enabled: true,
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      await unauthorized.close();
      await controls.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.id = "synthetic-child-controls";
        frame.src = location.href;
        document.body.appendChild(frame);
      });
      await expect.poll(() => controls.frames().length).toBe(2);
      const child = controls
        .frames()
        .find((frame) => frame.parentFrame() !== null)!;
      await child.waitForLoadState("domcontentloaded");
      expect(
        await child.evaluate(
          () =>
            typeof (
              globalThis as unknown as {
                chrome?: { runtime?: { sendMessage?: unknown } };
              }
            ).chrome?.runtime?.sendMessage,
        ),
      ).not.toBe("function");
      await controls.evaluate(() =>
        document.querySelector("#synthetic-child-controls")!.remove(),
      );
      await expect(controls.getByRole("status")).toHaveText(
        "Recording is off.",
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
      registered = true;
      await registerTestHost(browser, hostName, manifest, false, native);
      expect((await snapshot()).reads).toBe(0);
      expect((await coordinator.execute("start")).ok).toBe(true);
      await clientPermission(true);
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
      await page.bringToFront();
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
      // Reload an approved but ended client. Only the profile tag survives; recording needs another explicit click.
      const profileBeforeReload = await worker.evaluate(() =>
        (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: { get(key: string): Promise<Record<string, unknown>> };
              };
            };
          }
        ).chrome.storage.local.get("rewindProfileIdV1"),
      );
      const previousInstance = await worker.evaluate(
        () =>
          (globalThis as unknown as { probeInstanceId: string })
            .probeInstanceId,
      );
      const workerControl = await context.newCDPSession(page);
      await workerControl.send("ServiceWorker.enable");
      await workerControl.send("ServiceWorker.stopAllWorkers");
      if (!controls.isClosed()) await controls.close();
      controls = await context.newPage();
      await expect(async () => {
        await controls.goto(`chrome-extension://${loaded.id}/status.html`);
        await expect(
          controls.getByRole("button", { name: "Allow and connect" }),
        ).toBeEnabled({ timeout: 2000 });
      }).toPass({ timeout: 10000 });
      await expect
        .poll(
          async () => {
            for (const candidate of context!
              .serviceWorkers()
              .filter((item) =>
                item.url().startsWith(`chrome-extension://${loaded.id}/`),
              )) {
              try {
                const instance = await candidate.evaluate(
                  () =>
                    (globalThis as unknown as { probeInstanceId: string })
                      .probeInstanceId,
                );
                if (instance && instance !== previousInstance) {
                  worker = candidate;
                  return true;
                }
              } catch {
                /* A stopped execution context can be replaced while its target is still observed. */
              }
            }
            return false;
          },
          { timeout: 10000 },
        )
        .toBe(true);
      expect((await snapshot()).status).toMatchObject({
        permission: false,
        connected: false,
        collecting: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect((await snapshot()).reads).toBe(0);
      expect(
        await worker.evaluate(() =>
          (
            globalThis as unknown as {
              chrome: {
                storage: {
                  local: { get(key: string): Promise<Record<string, unknown>> };
                };
              };
            }
          ).chrome.storage.local.get("rewindProfileIdV1"),
        ),
      ).toEqual(profileBeforeReload);
      await clientPermission(true);
      await expect
        .poll(async () => (await snapshot()).status.connected, {
          timeout: 10000,
        })
        .toBe(true);
      await page.bringToFront();
      // A separate client revocation is an acknowledged permission gap, not an invented native disconnect.
      expect((await coordinator.execute("start")).ok).toBe(true);
      await expect
        .poll(async () => (await readEvents()).length, { timeout: 10000 })
        .toBe(3);
      await clientPermission(false);
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
      const extensionData = await worker.evaluate(() =>
        (
          globalThis as unknown as {
            chrome: {
              storage: {
                local: { get(input: null): Promise<Record<string, unknown>> };
              };
            };
          }
        ).chrome.storage.local.get(null),
      );
      expect(Object.keys(extensionData)).toEqual(["rewindProfileIdV1"]);
      expect(extensionData.rewindProfileIdV1).toMatch(/^[a-f0-9-]{36}$/);
      await expect(controls.getByRole("status")).toHaveText(
        "Recording is off.",
      );
      await controls.locator("body").screenshot({
        path: path.resolve(
          "test-results-browser",
          `extension-controls-${browser}.png`,
        ),
      });
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
        if (registered)
          await registerTestHost(browser, hostName, manifest, true, native);
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
