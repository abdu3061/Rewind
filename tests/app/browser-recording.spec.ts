import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type ElectronApplication,
  type Page,
  type Worker,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DesktopApi } from "@rewind/contracts";
import { generateBrowserAssets } from "../../apps/desktop/browser-assets";
import { extensionResponseSchema } from "../../apps/browser-extension/src/extension-controls";
import { registerTestHost } from "../browser/native-fixtures";
import { launchVerificationApp } from "./fixtures";

const instrumentation = String.raw`
let reads=0;
globalThis.probeReadCount=()=>reads;
for(const [owner,name] of [[chrome.windows,'getLastFocused'],[chrome.windows,'get'],[chrome.tabs,'query']]) {
  const original=owner[name].bind(owner);owner[name]=(...args)=>{reads++;return original(...args)};
}
`;
async function instrument(directory: string) {
  const extension = path.join(directory, "extension"),
    background = path.join(extension, "background.js");
  writeFileSync(path.join(extension, "probe.js"), instrumentation);
  writeFileSync(
    background,
    `import './probe.js';\n${readFileSync(background, "utf8")}`,
  );
  const file = path.join(directory, "assets.json"),
    inventory = JSON.parse(readFileSync(file, "utf8")) as {
      extension: { name: string; bytes: number; sha256: string }[];
    };
  inventory.extension = readdirSync(extension)
    .sort()
    .map((name) => {
      const bytes = readFileSync(path.join(extension, name));
      return {
        name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
  writeFileSync(file, JSON.stringify(inventory));
  return extension;
}
async function clientStatus(controls: Page) {
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
  if (!result.ok) throw new Error("SYNTHETIC_EXTENSION_STATUS_UNAVAILABLE");
  return result.value;
}
async function permission(worker: Worker, controls: Page, enabled: boolean) {
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
        (text) => {
          const popup = (
            globalThis as unknown as {
              chrome: {
                extension: { getViews(input: { type: string }): Window[] };
              };
            }
          ).chrome.extension.getViews({ type: "popup" })[0];
          const button =
            popup?.document.querySelector<HTMLButtonElement>("#permission");
          return Boolean(
            button && !button.disabled && button.textContent === text,
          );
        },
        enabled ? "Allow and connect" : "Stop recording",
      ),
    )
    .toBe(true);
  await controls.evaluate(() => {
    const popup = (
      globalThis as unknown as {
        chrome: { extension: { getViews(input: { type: string }): Window[] } };
      }
    ).chrome.extension.getViews({ type: "popup" })[0];
    popup!.document.querySelector<HTMLButtonElement>("#permission")!.click();
  });
  await expect
    .poll(
      async () => {
        const state = await clientStatus(controls);
        return state.permission === enabled && !state.pending;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await controls.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: { extension: { getViews(input: { type: string }): Window[] } };
      }
    ).chrome.extension
      .getViews({ type: "popup" })[0]
      ?.close(),
  );
}
const killHostScript = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
$request=[Console]::ReadLine() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class SyntheticHostStop {
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder path,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr process,uint ms);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr process);
 public static bool Stop(uint pid,string expected) {
  IntPtr handle=OpenProcess(0x101001,false,pid);if(handle==IntPtr.Zero)return false;
  try {StringBuilder image=new StringBuilder(1024);uint size=1024;
   if(!QueryFullProcessImageNameW(handle,0,image,ref size)||!String.Equals(image.ToString(),expected,StringComparison.OrdinalIgnoreCase)||WaitForSingleObject(handle,0)!=258)return false;
   return TerminateProcess(handle,1)&&WaitForSingleObject(handle,5000)==0;
  } finally {CloseHandle(handle);}
 }
}
'@
$count=0
foreach($item in @(Get-CimInstance Win32_Process -Filter "Name='RewindBrowserHost.exe'" | Where-Object {$_.ExecutablePath -eq $request.executable -and $_.CommandLine -notmatch '--broker|--registration'})) {
 if([SyntheticHostStop]::Stop([uint32]$item.ProcessId,[string]$request.executable)) {$count++}
}
[Console]::WriteLine($count)
`;
function disconnectOwnedHost(profile: string, executable: string) {
  const relative = path.relative(
    path.resolve(profile),
    path.resolve(executable),
  );
  if (
    !/^secure\\browser-host\\g-[a-f0-9-]{36}\\RewindBrowserHost\.exe$/.test(
      relative,
    )
  )
    throw new Error("UNSAFE_SYNTHETIC_HOST_TARGET");
  const count = Number(
    execFileSync(
      path.join(
        process.env.WINDIR ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(killHostScript, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 4096,
        encoding: "utf8",
        input: `${JSON.stringify({ executable })}\n`,
      },
    ).trim(),
  );
  expect(count).toBe(1);
}
function removeProfile(profile: string) {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(profile));
  if (
    !relative.startsWith("rewind-e2e-") ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative) ||
    lstatSync(profile).isSymbolicLink()
  )
    throw new Error("UNSAFE_BROWSER_APP_FIXTURE_CLEANUP");
  rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
for (const [browser, channel, executable] of [
  [
    "chrome",
    "chrome",
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Google/Chrome/Application/chrome.exe",
    ),
  ],
  [
    "edge",
    "msedge",
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft/Edge/Application/msedge.exe",
    ),
  ],
] as const)
  test(`${browser} records through the packaged worker and real UI, preserves kept evidence, and revokes on disconnect/restart`, async () => {
    test.setTimeout(180000);
    test.skip(
      process.platform !== "win32" || !existsSync(executable),
      "Installed Windows browser required.",
    );
    const profile = mkdtempSync(path.join(tmpdir(), "rewind-e2e-")),
      name = `com.rewind.test.${randomUUID().replaceAll("-", "")}`,
      assetRoot = path.join(profile, "browser-assets"),
      helper = path.join(assetRoot, "RewindBrowserHost.exe"),
      title = `PackagedBrowserEvidence7418 ${browser} Ölçüme <evidence>`;
    let application: ElectronApplication | null = null,
      context: BrowserContext | null = null,
      manifest = path.join(profile, "unregistered-synthetic.json");
    let bodyError: unknown, cleanupError: unknown;
    try {
      writeFileSync(
        path.join(profile, "synthetic-fixture.json"),
        JSON.stringify({ format: 1, synthetic: true }),
      );
      writeFileSync(
        path.join(profile, "browser-fixture.json"),
        JSON.stringify({ format: 1, hostName: name }),
      );
      await generateBrowserAssets(
        path.resolve("apps/desktop"),
        "win32",
        "x64",
        assetRoot,
        name,
      );
      const extension = await instrument(assetRoot);
      application = await launchVerificationApp(profile);
      let appPage = await application.firstWindow();
      await expect(appPage.getByTestId("session-status")).toHaveText(
        "not started",
      );
      await appPage
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await appPage.getByRole("tab", { name: "Browsers" }).click();
      await expect(appPage.getByTestId("browser-status")).toContainText(
        "Browser connection not set up",
      );
      await appPage
        .getByRole("checkbox", { name: label(browser), exact: true })
        .check();
      const other = appPage.getByRole("checkbox", {
        name: browser === "chrome" ? "Edge" : "Chrome",
        exact: true,
      });
      if (await other.count()) await other.uncheck();
      await appPage
        .getByRole("button", { name: "Set up browser connection", exact: true })
        .click();
      await appPage
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      expect(
        await appPage.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.browser.state(),
        ),
      ).toMatchObject({
        ok: true,
        value: { permission: false, setup: { state: "not-installed" } },
      });
      await appPage
        .getByRole("button", { name: "Set up browser connection", exact: true })
        .click();
      await appPage
        .getByRole("button", { name: "Confirm setup", exact: true })
        .click();
      await expect(appPage.getByTestId("browser-status")).toContainText(
        "Browser connection set up, ready",
        { timeout: 60000 },
      );
      const generation = readdirSync(
        path.join(profile, "secure/browser-host"),
      ).find((item) => /^g-[a-f0-9-]{36}$/.test(item));
      if (!generation) throw new Error("SYNTHETIC_INSTALLATION_MISSING");
      manifest = path.join(
        profile,
        "secure/browser-host",
        generation,
        "native-host.json",
      );
      expect(
        (JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name,
      ).toBe(name);
      context = await chromium.launchPersistentContext(
        path.join(profile, `browser-${browser}`),
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
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><title>${title.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</title><p>Synthetic routed page only.</p>`,
          }),
      );
      const browserPage = context.pages()[0] ?? (await context.newPage());
      await browserPage.goto(
        "http://rewind-fixture.invalid/first?token=synthetic#fragment",
      );
      const instance = context.browser();
      if (!instance) throw new Error("SYNTHETIC_BROWSER_MISSING");
      const cdp = await instance.newBrowserCDPSession(),
        loaded = await cdp.send("Extensions.loadUnpacked", {
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
      const controls = await context.newPage();
      await controls.goto(`chrome-extension://${loaded.id}/status.html`);
      const reads = () =>
        worker.evaluate(() =>
          (
            globalThis as unknown as { probeReadCount(): number }
          ).probeReadCount(),
        );
      expect(await reads()).toBe(0);
      expect((await clientStatus(controls)).permission).toBe(false);
      await appPage
        .getByRole("button", { name: "Dashboard", exact: true })
        .click();
      await appPage
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      await permission(worker, controls, true);
      await browserPage.bringToFront();
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(await reads()).toBe(0);
      await appPage
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await appPage.getByRole("tab", { name: "Browsers" }).click();
      await appPage
        .getByRole("button", {
          name: "Allow browser activity",
          exact: true,
        })
        .click();
      expect(await reads()).toBe(0);
      await appPage
        .getByRole("button", { name: "Dashboard", exact: true })
        .click();
      await expect(appPage.getByTestId("session-status")).toHaveText("paused");
      await appPage
        .getByRole("button", { name: "Resume", exact: true })
        .click();
      await browserPage.bringToFront();
      const events = () =>
        appPage.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
            limit: 100,
            types: ["browser-visit"],
            text: "PackagedBrowserEvidence7418",
          }),
        );
      await expect
        .poll(
          async () => {
            const result = await events();
            return result.ok ? result.value.length : -1;
          },
          { timeout: 15000 },
        )
        .toBe(1);
      expect(await events()).toMatchObject({
        ok: true,
        value: [
          {
            type: "browser-visit",
            payload: {
              browser,
              title,
              url: "http://rewind-fixture.invalid/first",
              endedAt: null,
            },
          },
        ],
      });
      expect(
        await appPage.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
        ),
      ).toMatchObject({
        ok: true,
        value: {
          preferences: { collectionConsent: false },
          filePermission: false,
          browserPermission: true,
        },
      });
      await appPage
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await appPage.getByRole("tab", { name: "Browsers" }).click();
      await appPage
        .getByLabel("Excluded websites (one host per line)")
        .fill("blocked.rewind-fixture.invalid");
      await appPage
        .getByRole("button", { name: "Save website exclusions", exact: true })
        .click();
      await expect(
        appPage.getByText(
          "Website exclusions saved. Browser permission is off; allow it again and resume the session.",
          { exact: true },
        ),
      ).toBeVisible();
      const paused = await reads();
      await browserPage.goto("http://rewind-fixture.invalid/paused");
      await browserPage.bringToFront();
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(await reads()).toBe(paused);
      await appPage
        .getByRole("button", {
          name: "Allow browser activity",
          exact: true,
        })
        .click();
      await browserPage.goto("http://blocked.rewind-fixture.invalid/excluded");
      await appPage
        .getByRole("button", { name: "Dashboard", exact: true })
        .click();
      await appPage
        .getByRole("button", { name: "Resume", exact: true })
        .click();
      await browserPage.bringToFront();
      // Resuming re-arms the extension asynchronously; slow runners need more
      // than one polling interval before the next page read.
      await expect.poll(reads, { timeout: 15000 }).toBeGreaterThan(paused);
      expect(await events()).toMatchObject({
        ok: true,
        value: [expect.anything()],
      });
      await appPage.getByRole("button", { name: "Pause", exact: true }).click();
      const stopped = await reads();
      await browserPage.goto(
        "http://rewind-fixture.invalid/second?private=fixture#fragment",
      );
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(await reads()).toBe(stopped);
      await appPage
        .getByRole("button", { name: "Resume", exact: true })
        .click();
      await browserPage.bringToFront();
      await expect
        .poll(
          async () => {
            const result = await events();
            return result.ok ? result.value.length : -1;
          },
          { timeout: 10000 },
        )
        .toBe(2);
      await appPage
        .getByRole("button", { name: "End session", exact: true })
        .click();
      const ended = await reads();
      await browserPage.goto("http://rewind-fixture.invalid/after-end");
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(await reads()).toBe(ended);
      await appPage
        .getByRole("button", { name: "Timeline", exact: true })
        .click();
      await expect(appPage.getByText(title, { exact: true })).toHaveCount(2);
      await appPage
        .getByRole("button", { name: "Checkpoints", exact: true })
        .click();
      await appPage
        .getByRole("button", { name: "Choose items…", exact: true })
        .click();
      await appPage
        .getByLabel("Checkpoint name", { exact: true })
        .fill(`Kept packaged browser ${browser}`);
      await appPage
        .getByRole("checkbox", { name: /Select activity / })
        .first()
        .check();
      await appPage
        .getByRole("button", { name: "Save checkpoint", exact: true })
        .click();
      await expect(appPage.getByTestId("saved-checkpoint")).toHaveCount(1);
      const removed = await appPage.evaluate(() =>
        (
          window as unknown as { rewind: DesktopApi }
        ).rewind.storage.deleteHistory({ confirmed: true, includeKept: false }),
      );
      expect(removed).toMatchObject({
        ok: true,
        value: { activityCount: 1, keptCheckpointCount: 1 },
      });
      for (const file of readdirSync(path.join(profile, "secure")).filter(
        (item) => item.startsWith("history.sqlite"),
      )) {
        const bytes = readFileSync(path.join(profile, "secure", file));
        for (const marker of [
          title,
          "rewind-fixture.invalid/first",
          "rewind-fixture.invalid/second",
        ])
          for (const encoding of ["utf8", "utf16le"] as const)
            expect(bytes.includes(Buffer.from(marker, encoding))).toBe(false);
      }
      await appPage
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await appPage.getByRole("tab", { name: "Browsers" }).click();
      // Headless installed browsers can leave Electron occluded and throttle its
      // animation frames. Focus the actual window before screenshot stability checks.
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.show();
        window.focus();
      });
      await appPage.bringToFront();
      await appPage
        .locator("section[aria-labelledby='browser-heading']")
        .screenshot({ path: `test-results/browser-settings-${browser}.png` });
      const storage = await worker.evaluate(() =>
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
      expect(Object.keys(storage)).toEqual(["rewindProfileIdV1"]);
      await application.close();
      application = null;
      await expect
        .poll(async () => (await clientStatus(controls)).permission)
        .toBe(false);
      application = await launchVerificationApp(profile);
      appPage = await application.firstWindow();
      await expect(appPage.getByTestId("session-status")).toHaveText("ended");
      await appPage
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await appPage.getByRole("tab", { name: "Browsers" }).click();
      await expect(appPage.getByTestId("browser-status")).toContainText(
        "Browser connection set up, ready",
      );
      await expect(
        appPage.getByLabel("Excluded websites (one host per line)"),
      ).toHaveValue("blocked.rewind-fixture.invalid");
      expect(
        await appPage.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.browser.state(),
        ),
      ).toMatchObject({ ok: true, value: { permission: false } });
      expect(await events()).toMatchObject({
        ok: true,
        value: [expect.anything()],
      });
      const restartReads = await reads();
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(await reads()).toBe(restartReads);
      await permission(worker, controls, true);
      await appPage
        .getByRole("button", {
          name: "Allow browser activity",
          exact: true,
        })
        .click();
      await appPage
        .getByRole("button", { name: "Dashboard", exact: true })
        .click();
      await appPage
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      await browserPage.goto("http://rewind-fixture.invalid/third");
      await browserPage.bringToFront();
      await expect
        .poll(
          async () => {
            const result = await events();
            return result.ok ? result.value.length : -1;
          },
          { timeout: 10000 },
        )
        .toBe(2);
      disconnectOwnedHost(
        profile,
        path.join(path.dirname(manifest), "RewindBrowserHost.exe"),
      );
      await expect
        .poll(async () => {
          const status = await clientStatus(controls);
          return !status.permission && !status.pending;
        })
        .toBe(true);
      await expect(appPage.getByTestId("collection-status")).toHaveText(
        "Recording unavailable",
      );
      const disconnected = await reads();
      await browserPage.goto("http://rewind-fixture.invalid/disconnected");
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect(await reads()).toBe(disconnected);
      await appPage
        .getByRole("button", {
          name: "Reconnect recording service",
          exact: true,
        })
        .click();
      await expect(appPage.getByTestId("session-status")).toHaveText("paused", {
        timeout: 15000,
      });
      expect(
        await appPage.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
        ),
      ).toMatchObject({
        ok: true,
        value: {
          browserPermission: false,
          preferences: { collectionConsent: false },
        },
      });
      expect(
        await appPage.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
            limit: 100,
            types: ["capture-gap"],
          }),
        ),
      ).toMatchObject({
        ok: true,
        value: expect.arrayContaining([
          expect.objectContaining({
            source: "browser",
            type: "capture-gap",
            payload: { collectorId: "browser", reason: "unavailable" },
          }),
        ]),
      });
      await appPage
        .getByRole("button", { name: "End session", exact: true })
        .click();
      await appPage
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await appPage.getByRole("tab", { name: "Browsers" }).click();
      await expect(appPage.getByTestId("browser-status")).toContainText(
        "Browser connection set up, ready",
      );
      await appPage
        .getByRole("button", {
          name: `Remove ${label(browser)} connection`,
          exact: true,
        })
        .click();
      await appPage
        .getByRole("button", { name: "Confirm removal", exact: true })
        .click();
      await expect(appPage.getByTestId("browser-status")).toContainText(
        "Browser connection not set up, off",
        { timeout: 30000 },
      );
    } catch (error) {
      bodyError = error;
    } finally {
      try {
        if (application) {
          if (bodyError) {
            try {
              const page = await application.firstWindow();
              await page.evaluate(async () => {
                const api = (window as unknown as { rewind: DesktopApi })
                  .rewind;
                await api.runtime.retry();
                await api.sessions.end();
              });
            } catch {
              /* A broken app may require the owned child process fallback below. */
            }
          }
          try {
            await application.close();
            application = null;
          } catch {
            /* Preserve the original error and observe forced child exit below if needed. */
          }
        }
        if (application) {
          if (
            bodyError &&
            application.process().exitCode === null &&
            application.process().signalCode === null
          ) {
            const child = application.process(),
              exited = new Promise<void>((resolve) =>
                child.once("exit", () => resolve()),
              );
            child.kill();
            await exited;
          } else await application.close();
        }
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (context) await context.close();
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        const installs = path.join(profile, "secure/browser-host");
        if (existsSync(installs)) {
          const generation = readdirSync(installs).find((item) =>
            /^g-[a-f0-9-]{36}$/.test(item),
          );
          if (generation)
            manifest = path.join(installs, generation, "native-host.json");
        }
        if (existsSync(helper))
          await registerTestHost(browser, name, manifest, true, helper);
      } catch (error) {
        cleanupError ??= error;
      }
      if (!cleanupError)
        try {
          removeProfile(profile);
        } catch (error) {
          cleanupError = error;
        }
    }
    if (bodyError && cleanupError)
      throw new AggregateError(
        [bodyError, cleanupError],
        "Packaged browser verification and cleanup failed; preserved fixture.",
      );
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  });
function label(browser: "chrome" | "edge") {
  return browser === "chrome" ? "Chrome" : "Edge";
}
