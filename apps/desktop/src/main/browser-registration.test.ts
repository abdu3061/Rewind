import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { generateBrowserAssets } from "../../browser-assets";
import { NativeBrowserRegistration } from "./browser-registration";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

let root: string, executable: string;
const fixtures: { browser: "chrome" | "edge"; name: string }[] = [];
const fixtureScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
$request=[Console]::ReadLine() | ConvertFrom-Json
if($request.name -notmatch '^com\.rewind\.test\.[a-f0-9]{32}$') {throw 'FIXTURE_NAME_INVALID'}
$brand=switch($request.browser) {'chrome' {'Google\Chrome'} 'edge' {'Microsoft\Edge'} default {throw 'FIXTURE_BROWSER_INVALID'}}
$name='Software\'+$brand+'\NativeMessagingHosts\'+$request.name
$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
try {
  if($request.operation -eq 'cleanup') {
    $key=$base.OpenSubKey($name)
    if($null -ne $key) {
      try {
        if(@($key.GetValueNames() | Where-Object {$_ -ne '' -and $_ -ne 'synthetic-extra'}).Length -ne 0) {throw 'FIXTURE_UNKNOWN_VALUE'}
        if(@($key.GetSubKeyNames() | Where-Object {$_ -ne 'synthetic-child'}).Length -ne 0) {throw 'FIXTURE_UNKNOWN_CHILD'}
      } finally {$key.Dispose()}
      $base.DeleteSubKeyTree($name,$false)
    }
    [Console]::WriteLine('{}');return
  }
  $key=$base.CreateSubKey($name)
  try {
    switch($request.operation) {
      'set' {$key.SetValue('',[string]$request.value,[Microsoft.Win32.RegistryValueKind]::String)}
      'extra' {$key.SetValue('synthetic-extra','synthetic fixture',[Microsoft.Win32.RegistryValueKind]::String)}
      'child' {$child=$key.CreateSubKey('synthetic-child');$child.Dispose()}
      'expand' {$key.SetValue('',[string]$request.value,[Microsoft.Win32.RegistryValueKind]::ExpandString)}
      'read' {}
      default {throw 'FIXTURE_OPERATION_INVALID'}
    }
    [Console]::WriteLine((@{value=$key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);names=@($key.GetValueNames());children=@($key.GetSubKeyNames())} | ConvertTo-Json -Compress))
  } finally {$key.Dispose()}
} finally {$base.Dispose()}
`;
function edit(
  browser: "chrome" | "edge",
  name: string,
  operation: string,
  value = "",
) {
  return JSON.parse(
    execFileSync(
      path.join(
        process.env.WINDIR ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(fixtureScript, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 4096,
        encoding: "utf8",
        input: `${JSON.stringify({ browser, name, operation, value })}\n`,
      },
    ),
  ) as { value: string | null; names: string[]; children: string[] };
}
function fixture(browser: "chrome" | "edge") {
  const name = `com.rewind.test.${randomUUID().replaceAll("-", "")}`;
  fixtures.push({ browser, name });
  return {
    name,
    registration: new NativeBrowserRegistration(executable, name),
    manifest: path.join(root, `${browser}-${name}.json`),
    updated: path.join(root, `updated-${browser}-${name}.json`),
  };
}
beforeAll(async () => {
  if (process.platform !== "win32") return;
  root = newSecureFixture();
  await generateBrowserAssets(
    path.resolve("apps/desktop"),
    "win32",
    "x64",
    path.join(root, "browser"),
  );
  executable = path.join(root, "browser/RewindBrowserHost.exe");
}, 20000);
afterAll(() => {
  const errors: unknown[] = [];
  for (const item of fixtures)
    try {
      edit(item.browser, item.name, "cleanup");
    } catch (error) {
      errors.push(error);
    }
  if (root && !errors.length) removeSecureFixture(root);
  if (errors.length)
    throw new AggregateError(
      errors,
      "Synthetic registry fixture cleanup failed; preserved files.",
    );
});

it.skipIf(process.platform !== "win32").each(["chrome", "edge"] as const)(
  "%s installs, verifies, updates and removes only the owned registration in both views",
  async (browser) => {
    const f = fixture(browser),
      r = f.registration;
    expect(await r.inspect(browser, f.manifest)).toEqual({
      ok: true,
      value: { state: "absent", registeredViews: 0 },
    });
    expect(await r.install(browser, f.manifest, null)).toEqual({
      ok: true,
      value: { state: "registered", registeredViews: 2 },
    });
    expect(await r.inspect(browser, f.manifest)).toMatchObject({
      ok: true,
      value: { state: "registered" },
    });
    expect((await r.install(browser, f.updated, null)).ok).toBe(false);
    expect(await r.inspect(browser, f.updated)).toMatchObject({
      ok: true,
      value: { state: "conflict" },
    });
    expect(edit(browser, f.name, "read").value).toBe(f.manifest);
    expect(await r.install(browser, f.updated, f.manifest)).toMatchObject({
      ok: true,
      value: { state: "registered", registeredViews: 2 },
    });
    expect(await r.remove(browser, f.manifest)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(edit(browser, f.name, "read").value).toBe(f.updated);
    expect(await r.remove(browser, f.updated)).toEqual({
      ok: true,
      value: { state: "absent", registeredViews: 0 },
    });
    expect(edit(browser, f.name, "read")).toMatchObject({
      value: null,
      names: [],
      children: [],
    });
    // Empty keys are preserved. Reinstallation needs the utility's retained ownership receipt.
    expect((await r.install(browser, f.manifest, null)).ok).toBe(false);
    expect(await r.install(browser, f.manifest, f.updated)).toMatchObject({
      ok: true,
      value: { state: "registered" },
    });
    expect((await r.remove(browser, f.manifest)).ok).toBe(true);
  },
  20000,
);

it
  .skipIf(process.platform !== "win32")
  .each(["set", "extra", "child", "expand"] as const)(
  "preserves conflicting %s registry data and refuses install/removal",
  async (operation) => {
    const f = fixture("chrome"),
      r = f.registration;
    const unknown = path.join(root, "different-synthetic-owner.json");
    edit("chrome", f.name, "set", operation === "set" ? unknown : f.manifest);
    if (operation !== "set") edit("chrome", f.name, operation, f.manifest);
    const original = edit("chrome", f.name, "read");
    expect(await r.inspect("chrome", f.manifest)).toMatchObject({
      ok: true,
      value: { state: "conflict" },
    });
    expect(await r.install("chrome", f.updated, f.manifest)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(await r.remove("chrome", f.manifest)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(edit("chrome", f.name, "read")).toEqual(original);
  },
  15000,
);

it.skipIf(process.platform !== "win32")(
  "serializes independent native installers so concurrent different registrations cannot both succeed",
  async () => {
    const f = fixture("edge");
    const results = await Promise.all([
      f.registration.install("edge", f.manifest, null),
      new NativeBrowserRegistration(executable, f.name).install(
        "edge",
        f.updated,
        null,
      ),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const owner = results[0]!.ok ? f.manifest : f.updated;
    expect(edit("edge", f.name, "read").value).toBe(owner);
    expect(await f.registration.inspect("edge", owner)).toMatchObject({
      ok: true,
      value: { state: "registered", registeredViews: 2 },
    });
    expect((await f.registration.remove("edge", owner)).ok).toBe(true);
  },
);

it("rejects expanded paths, malformed host names and unexpected inputs before launching a helper", async () => {
  for (const manifest of [
    "relative.json",
    "C:\\temp\\..\\other.json",
    "\\\\server\\share\\host.json",
    "C:\\temp\\host.json:stream",
    "C:\\temp\\host.json\n",
  ]) {
    expect(
      (
        await new NativeBrowserRegistration(
          "C:\\synthetic\\missing.exe",
        ).install("chrome", manifest, null)
      ).ok,
    ).toBe(false);
  }
  expect(
    (
      await new NativeBrowserRegistration(
        "C:\\synthetic\\missing.exe",
        "another.host",
      ).install("chrome", "C:\\synthetic\\host.json", null)
    ).ok,
  ).toBe(false);
});
