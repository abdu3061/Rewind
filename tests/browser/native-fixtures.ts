import { execFileSync } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
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
export function registerTestHost(
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
