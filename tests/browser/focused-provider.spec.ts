import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import type { NativeBrowserMessage } from "@rewind/contracts";

interface ProbeResult {
  calls: {
    windows: number;
    tabs: number;
    rechecks: number;
    urls: number;
    titles: number;
  };
  messages: NativeBrowserMessage[];
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
  test(`${browser} queries synthetic focused metadata only with dual consent and applies exclusions before titles`, async () => {
    test.skip(
      process.platform !== "win32" || !existsSync(executable),
      "Installed Windows browser required.",
    );
    const root = mkdtempSync(path.join(tmpdir(), "rewind-browser-e2e-"));
    let context: BrowserContext | null = null;
    let bodyError: unknown, cleanupError: unknown;
    try {
      const extension = path.join(root, "extension"),
        entry = path.join(root, "probe-entry.ts");
      mkdirSync(extension);
      writeFileSync(
        entry,
        `
import { focusedBrowserTab } from ${JSON.stringify(path.resolve("apps/browser-extension/src/focused-tab-provider.ts").replaceAll("\\", "/"))};
import { BrowserMetadataController } from ${JSON.stringify(path.resolve("apps/browser-extension/src/metadata-controller.ts").replaceAll("\\", "/"))};
globalThis.probe = async ({permission, active, excluded}) => {
  const calls={windows:0,tabs:0,rechecks:0,urls:0,titles:0},messages=[];
  const access={
    lastFocusedWindow:()=>{calls.windows++;return chrome.windows.getLastFocused({populate:false,windowTypes:["normal"]});},
    activeTabs:async(windowId)=>{calls.tabs++;const tabs=await chrome.tabs.query({active:true,windowId});return tabs.map(tab=>new Proxy(tab,{get(target,key,receiver){if(key==="url")calls.urls++;if(key==="title")calls.titles++;return Reflect.get(target,key,receiver);}}));},
    window:(windowId)=>{calls.rechecks++;return chrome.windows.get(windowId,{populate:false});},
  };
  const connectionId=crypto.randomUUID(), sessionId=crypto.randomUUID(), generationId=crypto.randomUUID();
  const controller=new BrowserMetadataController({connectionId,browser:${JSON.stringify(browser)},now:Date.now,monotonicNow:()=>performance.now(),getFocusedTab:(authorized)=>focusedBrowserTab(access,authorized),send:message=>messages.push(message),unavailable:()=>{}});
  await controller.permission(permission);
  const result=await controller.state({version:2,type:"state",connectionId,browser:${JSON.stringify(browser)},revision:1,authority:active?{sessionId,generationId,capability:"a".repeat(64),expiresAt:new Date(Date.now()+4000).toISOString(),validForMs:4000,excludedSiteHosts:excluded}:null});
  if(!result.ok)throw new Error("SYNTHETIC_AUTHORITY_INVALID");
  await controller.sample();
  await controller.permission(false);
  return {calls,messages};
};
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
          name: "Synthetic Rewind Focused Provider Probe",
          version: "1.0",
          permissions: ["tabs"],
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
      await context.route("http://rewind-fixture.invalid/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Synthetic focused provider evidence</title><p>Synthetic test page only.</p>",
        }),
      );
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(
        "http://rewind-fixture.invalid/work?token=synthetic#fragment",
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
      const probe = (
        permission: boolean,
        active: boolean,
        excluded: string[] = [],
      ) =>
        worker.evaluate(
          (value) =>
            (
              globalThis as unknown as {
                probe(input: typeof value): Promise<ProbeResult>;
              }
            ).probe(value),
          { permission, active, excluded },
        );
      for (const [permission, active] of [
        [false, false],
        [false, true],
        [true, false],
      ]) {
        const result = await probe(permission!, active!);
        expect(result.calls).toEqual({
          windows: 0,
          tabs: 0,
          rechecks: 0,
          urls: 0,
          titles: 0,
        });
        expect(
          result.messages.every((message) => message.type === "stopped"),
        ).toBe(true);
      }
      const enabled = await probe(true, true);
      expect(enabled.calls).toMatchObject({ windows: 1, tabs: 1, rechecks: 1 });
      expect(enabled.calls.titles).toBeGreaterThan(0);
      expect(enabled.messages).toEqual([
        expect.objectContaining({
          type: "visit",
          incognito: false,
          focused: true,
          url: "http://rewind-fixture.invalid/work",
          title: "Synthetic focused provider evidence",
        }),
      ]);
      const excluded = await probe(true, true, ["rewind-fixture.invalid"]);
      expect(excluded.messages).toEqual([]);
      expect(excluded.calls.urls).toBeGreaterThan(0);
      expect(excluded.calls.titles).toBe(0);
      await page.goto("about:blank");
      await page.bringToFront();
      const restricted = await probe(true, true);
      expect(restricted.messages).toEqual([]);
      expect(restricted.calls.titles).toBe(0);
    } catch (error) {
      bodyError = error;
    } finally {
      try {
        if (context) await context.close();
      } catch (error) {
        cleanupError = error;
      }
      if (!cleanupError) {
        try {
          const relative = path.relative(
            path.resolve(tmpdir()),
            path.resolve(root),
          );
          if (
            !relative.startsWith("rewind-browser-e2e-") ||
            relative.includes(path.sep) ||
            path.isAbsolute(relative) ||
            lstatSync(root).isSymbolicLink()
          )
            cleanupError = new Error("UNSAFE_BROWSER_PROVIDER_FIXTURE_CLEANUP");
          else rmSync(root, { recursive: true, force: true });
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (bodyError && cleanupError)
      throw new AggregateError(
        [bodyError, cleanupError],
        "Synthetic browser provider and cleanup failed.",
      );
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  });
}
