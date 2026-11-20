import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import source from "../native/browser-process-proof.cs?raw";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeSecureFixture(root);
});
const bootstrap = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
Add-Type -TypeDefinition $source -Language CSharp
$request=[Console]::ReadLine() | ConvertFrom-Json
switch($request.kind) {
  'process' {
    $peer=[Rewind.NativeBrowser.ProcessProof]::Query([uint32]$request.pid)
    $self=[Rewind.NativeBrowser.ProcessProof]::Query([uint32]$PID)
    try { $result=@{ path=$peer.path; alive=$peer.Alive(); parentObserved=$self.DirectChildOf($peer); sameUser=($self.userSid -eq $peer.userSid); createdPositive=($peer.created -gt 0) } }
    finally {$peer.Dispose();$self.Dispose()}
    $result.closed= -not $peer.Alive()
  }
  'file' { $result=@{valid=[Rewind.NativeBrowser.BrowserBinaryProof]::Verify([string]$request.path,[string]$request.browser);hash=[Rewind.NativeBrowser.BrowserBinaryProof]::Hash([string]$request.path)} }
  'invalid' { try {$peer=[Rewind.NativeBrowser.ProcessProof]::Query([uint32]$request.pid);$peer.Dispose();$result=@{rejected=$false}} catch {$result=@{rejected=$true}} }
  'pipe' {
    $name='rewind.proof.'+[Guid]::NewGuid().ToString('N')
    $server=[Rewind.NativeBrowser.PrivatePipe]::FirstServer($name)
    $client=New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try {
      $wait=$server.WaitForConnectionAsync()
      $client.Connect(1000);[void]($wait.GetAwaiter().GetResult())
      $serverProof=[Rewind.NativeBrowser.ProcessProof]::PipePeer($client.SafePipeHandle,$true)
      $clientProof=[Rewind.NativeBrowser.ProcessProof]::PipePeer($server.SafePipeHandle,$false)
      try {
        $result=@{serverObserved=($serverProof.id -eq $PID);clientObserved=($clientProof.id -eq $PID);sameUser=($serverProof.userSid -eq $clientProof.userSid);collisionRejected=$false;descriptor=$server.GetAccessControl().GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)}
        try {$collision=[Rewind.NativeBrowser.PrivatePipe]::FirstServer($name);$collision.Dispose()} catch {$result.collisionRejected=$true}
      } finally {$serverProof.Dispose();$clientProof.Dispose()}
    } finally {$client.Dispose();$server.Dispose()}
  }
  'exited' {
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=[IO.Path]::Combine([Environment]::GetFolderPath('System'),'WindowsPowerShell\v1.0\powershell.exe')
    $start.Arguments='-NoProfile -NonInteractive -Command "[void][Console]::ReadLine(); exit 259"'
    $start.RedirectStandardInput=$true
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WindowStyle='Hidden'
    $child=[Diagnostics.Process]::Start($start)
    $proof=[Rewind.NativeBrowser.ProcessProof]::Query([uint32]$child.Id)
    try {
      $before=$proof.Alive()
      $child.StandardInput.WriteLine('finish');$child.StandardInput.Close()
      if(-not $child.WaitForExit(10000)) {throw 'FIXTURE_PROCESS_TIMEOUT'}
      $result=@{before=$before;after=$proof.Alive();exitCode=$child.ExitCode}
    } finally {if(-not $child.HasExited) {$child.Kill()};$child.Dispose();$proof.Dispose()}
  }
  default {throw 'FIXTURE_COMMAND_INVALID'}
}
[Console]::WriteLine(($result | ConvertTo-Json -Compress))
`.trim();
function query(request: unknown): Record<string, unknown> {
  const program = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const output = execFileSync(
    program,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(bootstrap, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
      input:
        Buffer.from(source, "utf8").toString("base64") +
        "\n" +
        JSON.stringify(request) +
        "\n",
    },
  );
  return JSON.parse(output.trim()) as Record<string, unknown>;
}
it.runIf(process.platform === "win32")(
  "observes the actual same-user process and direct parent, keeps a live handle and rejects invalid identities",
  () => {
    expect(query({ kind: "process", pid: process.pid })).toEqual({
      path: realpathSync(process.execPath),
      alive: true,
      sameUser: true,
      parentObserved: true,
      createdPositive: true,
      closed: true,
    });
    expect(query({ kind: "invalid", pid: 0 })).toEqual({ rejected: true });
    expect(query({ kind: "invalid", pid: 4294967295 })).toEqual({
      rejected: true,
    });
  },
  25000,
);
it.runIf(process.platform === "win32")(
  "does not mistake an exited process with code 259 for a live authenticated peer",
  () => {
    expect(query({ kind: "exited" })).toEqual({
      before: true,
      after: false,
      exitCode: 259,
    });
  },
  20000,
);
it.runIf(process.platform === "win32")(
  "creates a private local first-instance pipe and observes both actual peers without accepting a name collision",
  () => {
    const result = query({ kind: "pipe" });
    expect(result).toMatchObject({
      serverObserved: true,
      clientObserved: true,
      sameUser: true,
      collisionRejected: true,
    });
    const descriptor = String(result.descriptor);
    expect(descriptor.startsWith("D:P")).toBe(true);
    expect(descriptor).toContain(";;;NU)");
    expect(descriptor).not.toContain(";;;WD)");
    expect(descriptor).not.toContain(";;;AU)");
    expect((descriptor.match(/\(A;/g) ?? []).length).toBe(1);
  },
  20000,
);
it.runIf(process.platform === "win32")(
  "rejects an executable renamed to a browser when its trusted publisher is different",
  () => {
    const root = newSecureFixture();
    roots.push(root);
    const renamed = path.join(root, "chrome.exe");
    copyFileSync(process.execPath, renamed);
    const result = query({ kind: "file", path: renamed, browser: "chrome" });
    expect(result.valid).toBe(false);
    expect(result.hash).toBe(
      createHash("sha256").update(readFileSync(renamed)).digest("hex"),
    );
  },
  20000,
);
it.runIf(process.platform === "win32")(
  "verifies the installed signed Chrome and Edge executables without opening a browser or reading a profile",
  () => {
    for (const [browser, file] of [
      [
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
        path.join(
          process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        ),
      ],
    ] as const) {
      if (!existsSync(file)) continue;
      const result = query({ kind: "file", path: file, browser });
      expect(result.valid).toBe(true);
      expect(result.hash).toBe(
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      );
    }
  },
  30000,
);
