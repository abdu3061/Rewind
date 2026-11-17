import { execFileSync } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeBrowserRegistration } from "../../apps/desktop/src/main/browser-registration";

const registrationScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
$request=[Console]::ReadLine() | ConvertFrom-Json
if($request.name -notmatch '^com\.rewind\.test\.[a-f0-9]{32}$') {throw 'FIXTURE_HOST_NAME_INVALID'}
$brand=switch($request.browser) {'chrome' {'Google\Chrome'} 'edge' {'Microsoft\Edge'} default {throw 'FIXTURE_BROWSER_INVALID'}}
$name='Software\'+$brand+'\NativeMessagingHosts\'+$request.name
foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
  try {
    $existing=$base.OpenSubKey($name)
    if($null -ne $existing) {
      try {if($existing.GetValueNames().Length -ne 0 -or $existing.SubKeyCount -ne 0) {throw 'FIXTURE_REGISTRY_CHANGED'}} finally {$existing.Dispose()}
      $base.DeleteSubKey($name,$false)
    }
  } finally {$base.Dispose()}
}
[Console]::WriteLine('{"ok":true}')
`;
export async function registerTestHost(
  browser: "chrome" | "edge",
  name: string,
  manifest: string,
  remove: boolean,
  nativeExecutable: string,
) {
  if (!/^com\.rewind\.test\.[a-f0-9]{32}$/.test(name))
    throw new Error("FIXTURE_HOST_NAME_INVALID");
  const registration = new NativeBrowserRegistration(nativeExecutable, name);
  const changed = remove
    ? await registration.remove(browser, manifest)
    : await registration.install(browser, manifest, null);
  if (!changed.ok || changed.value.state !== (remove ? "absent" : "registered"))
    throw new Error("FIXTURE_REGISTRATION_UNCONFIRMED");
  if (!remove) return;
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
      input: JSON.stringify({ browser, name }) + "\n",
      encoding: "utf8",
    },
  );
  if (!(JSON.parse(result.trim()) as { ok: boolean }).ok)
    throw new Error("FIXTURE_REGISTRATION_UNCONFIRMED");
}
export function removeBrowserFixture(root: string) {
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
