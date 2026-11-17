import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const registrationScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
$request=[Console]::ReadLine() | ConvertFrom-Json
if($request.name -notmatch '^com\.rewind\.test\.[a-f0-9]{32}$') {throw 'FIXTURE_HOST_NAME_INVALID'}
$brand=switch($request.browser) {'chrome' {'Google\Chrome'} 'edge' {'Microsoft\Edge'} default {throw 'FIXTURE_BROWSER_INVALID'}}
$name='Software\'+$brand+'\NativeMessagingHosts\'+$request.name
$base=[Microsoft.Win32.Registry]::CurrentUser
$existing=$base.OpenSubKey($name)
if($request.remove) {
  if($null -ne $existing) {
    try {if($existing.GetValue('') -ne $request.manifest -or $existing.SubKeyCount -ne 0) {throw 'FIXTURE_REGISTRY_CHANGED'}} finally {$existing.Dispose()}
    $base.DeleteSubKey($name,$false)
  }
} else {
  if($null -ne $existing) {$existing.Dispose();throw 'FIXTURE_REGISTRY_EXISTS'}
  $created=$base.CreateSubKey($name)
  try {
    if($created.GetValueNames().Length -ne 0 -or $created.SubKeyCount -ne 0) {throw 'FIXTURE_REGISTRY_RACE'}
    $created.SetValue('',[string]$request.manifest,[Microsoft.Win32.RegistryValueKind]::String)
  } finally {$created.Dispose()}
}
[Console]::WriteLine('{"ok":true}')
`;
function register(
  browser: string,
  name: string,
  manifest: string,
  remove: boolean,
) {
  const executable = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = execFileSync(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(registrationScript, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4096,
      input: JSON.stringify({ browser, name, manifest, remove }) + "\n",
      encoding: "utf8",
    },
  );
  if (!(JSON.parse(result.trim()) as { ok: boolean }).ok)
    throw new Error("FIXTURE_REGISTRATION_UNCONFIRMED");
}
function removeFixture(root: string) {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  if (
    !relative.startsWith("rewind-browser-e2e-") ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative) ||
    lstatSync(root).isSymbolicLink()
  )
    throw new Error("UNSAFE_BROWSER_FIXTURE_CLEANUP");
  rmSync(root, { recursive: true, force: true });
}
const hash = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
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
  test(`${browser} authenticates the generated native relay through an isolated extension/profile`, async () => {
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
      child: ChildProcessWithoutNullStreams | null = null;
    let registered = false,
      exited: Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }> | null = null,
      closed = false;
    let succeeded = false;
    let bodyError: unknown, cleanupError: unknown;
    let stopResult: {
      code: number | null;
      signal: NodeJS.Signals | null;
    } | null = null;
    const messages: {
      type: string;
      channelId?: string;
      browser?: string;
      origin?: string;
      payload?: string;
    }[] = [];
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
      const extension = path.join(root, "extension");
      mkdirSync(extension);
      writeFileSync(
        path.join(extension, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Synthetic Rewind Native Relay Probe",
          version: "1.0",
          permissions: ["nativeMessaging"],
          incognito: "not_allowed",
          background: { service_worker: "probe.js" },
        }),
      );
      writeFileSync(
        path.join(extension, "probe.js"),
        String.raw`
globalThis.probeMessages=[];globalThis.probeError=null;
globalThis.openProbe=(host)=>{
  const port=chrome.runtime.connectNative(host);globalThis.probePort=port;
  port.onMessage.addListener((message)=>globalThis.probeMessages.push(message));
  port.onDisconnect.addListener(()=>{globalThis.probeError=chrome.runtime.lastError?.message ?? 'disconnected'});
  port.postMessage({type:'synthetic-native-probe',text:'Synthetic relay fixture'});
};
chrome.runtime.onInstalled.addListener(()=>{});
`,
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
      const instance = context.browser();
      if (!instance) throw new Error("BROWSER_DEBUG_SESSION_UNAVAILABLE");
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
      const config = {
        version: 1,
        pipeName: `rewind.browser.test.${nonce}`,
        desktopPath: process.execPath,
        desktopHash: hash(process.execPath),
        hostHash: hash(native),
        origins: [`chrome-extension://${loaded.id}/`],
        browsers: [{ kind: browser, path: executable }],
      };
      writeFileSync(native + ".json", JSON.stringify(config));
      writeFileSync(
        manifest,
        JSON.stringify({
          name: hostName,
          description: "Temporary synthetic Rewind relay test",
          path: native,
          type: "stdio",
          allowed_origins: config.origins,
        }),
      );
      child = spawn(native, ["--broker"], { windowsHide: true, stdio: "pipe" });
      exited = new Promise((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", (code, signal) => {
          closed = true;
          resolve({ code, signal });
        });
      });
      let output = "";
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        output += data;
        while (output.includes("\n")) {
          const at = output.indexOf("\n");
          messages.push(
            JSON.parse(output.slice(0, at)) as (typeof messages)[number],
          );
          output = output.slice(at + 1);
        }
      });
      child.stdin.write(JSON.stringify(config) + "\n");
      await expect
        .poll(() => messages.some((item) => item.type === "ready"), {
          timeout: 10000,
        })
        .toBe(true);
      register(browser, hostName, manifest, false);
      registered = true;
      await worker.evaluate(
        (host) =>
          (
            globalThis as unknown as { openProbe: (name: string) => void }
          ).openProbe(host),
        hostName,
      );
      await expect
        .poll(
          async () => ({
            connected: messages.some((item) => item.type === "connected"),
            error: await worker.evaluate(
              () =>
                (globalThis as unknown as { probeError: unknown }).probeError,
            ),
          }),
          { timeout: 15000 },
        )
        .toEqual({ connected: true, error: null });
      const connected = messages.find((item) => item.type === "connected")!;
      expect(connected.browser).toBe(browser);
      expect(connected.origin).toBe(config.origins[0]);
      await expect
        .poll(() => messages.some((item) => item.type === "message"), {
          timeout: 10000,
        })
        .toBe(true);
      const received = messages.find((item) => item.type === "message")!;
      expect(
        JSON.parse(Buffer.from(received.payload!, "base64").toString("utf8")),
      ).toEqual({
        type: "synthetic-native-probe",
        text: "Synthetic relay fixture",
      });
      child.stdin.write(
        JSON.stringify({
          type: "send",
          channelId: connected.channelId,
          payload: Buffer.from(
            JSON.stringify({ syntheticReply: true }),
            "utf8",
          ).toString("base64"),
        }) + "\n",
      );
      await expect
        .poll(
          () =>
            worker.evaluate(
              () =>
                (globalThis as unknown as { probeMessages: unknown[] })
                  .probeMessages,
            ),
          { timeout: 10000 },
        )
        .toEqual([{ syntheticReply: true }]);
      await worker.evaluate(() =>
        (
          globalThis as unknown as { probePort: { disconnect(): void } }
        ).probePort.disconnect(),
      );
      await expect
        .poll(
          () =>
            messages.some(
              (item) =>
                item.type === "disconnected" &&
                item.channelId === connected.channelId,
            ),
          { timeout: 5000 },
        )
        .toBe(true);
      await worker.evaluate(
        (host) =>
          (
            globalThis as unknown as { openProbe: (name: string) => void }
          ).openProbe(host),
        hostName,
      );
      await expect
        .poll(
          () => messages.filter((item) => item.type === "connected").length,
          { timeout: 10000 },
        )
        .toBe(2);
      const replacement = messages.filter(
        (item) => item.type === "connected",
      )[1]!;
      expect(replacement.channelId).not.toBe(connected.channelId);
      expect(replacement.browser).toBe(browser);
      await expect
        .poll(() => messages.filter((item) => item.type === "message").length, {
          timeout: 10000,
        })
        .toBe(2);
      succeeded = true;
    } catch (error) {
      bodyError = error;
    } finally {
      try {
        if (context) await context.close();
      } catch (error) {
        cleanupError = error;
      }
      if (child && !closed) child.stdin.write('{"type":"shutdown"}\n');
      if (exited) {
        const timer = setTimeout(() => child?.kill(), 3000);
        try {
          stopResult = await exited;
        } catch (error) {
          cleanupError ??= error;
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        if (registered) register(browser, hostName, manifest, true);
      } catch (error) {
        cleanupError ??= error;
      }
      if (!cleanupError) {
        try {
          removeFixture(root);
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (bodyError && cleanupError)
      throw new AggregateError(
        [bodyError, cleanupError],
        "The synthetic relay test and cleanup both failed.",
      );
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
    if (succeeded) expect(stopResult).toEqual({ code: 0, signal: null });
  });
}
