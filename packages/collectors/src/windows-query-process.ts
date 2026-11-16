import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ActiveWindowInfo, WindowQueryStrategy } from "./types";

const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ActiveWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
if (-not ([System.Management.Automation.PSTypeName]'ActiveWindow').Type) { Add-Type -TypeDefinition $code -Language CSharp }
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    if ($line.Length -gt 512000) { exit 1 }
    $request = $line | ConvertFrom-Json
    $denied = @('chrome','msedge','firefox','brave','opera','rewind')
    foreach ($item in $request.excludedApplications) { $denied += ([string]$item).Trim().ToLowerInvariant() -replace '\\.exe$','' }
    $observation = $null
    $handle = [ActiveWindow]::GetForegroundWindow()
    if ($handle -ne [IntPtr]::Zero) {
      [uint32]$foregroundProcessId = 0
      [ActiveWindow]::GetWindowThreadProcessId($handle, [ref]$foregroundProcessId) | Out-Null
      if ($foregroundProcessId -gt 0) {
        $proc = Get-Process -Id $foregroundProcessId -ErrorAction Stop
        $appName = $proc.ProcessName
        # Deny before GetWindowText: even a transient title must not cross this boundary.
        if ($appName.ToLowerInvariant() -notin $denied) {
          $text = New-Object System.Text.StringBuilder 2048
          [ActiveWindow]::GetWindowText($handle, $text, 2048) | Out-Null
          $observation = @{ application=$appName; windowTitle=$text.ToString() }
        }
      }
    }
    [Console]::WriteLine((@{ ok=$true; observation=$observation } | ConvertTo-Json -Compress))
  } catch {
    [Console]::WriteLine('{"ok":false}')
    exit 1
  }
}
`.trim();

interface QueryOptions {
  /** Trusted test seam. Never supplied from renderer or stored observations. */
  spawnProcess?: (script: string) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
}
/** One lazy helper per run; C# is compiled once, and sampling only follows explicit requests. */
export class WindowsWindowQueryStrategy implements WindowQueryStrategy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: {
    resolve: (value: ActiveWindowInfo | null) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private buffered = "";
  private failed = false;
  private exited: Promise<void> = Promise.resolve();
  private readonly timeout: number;
  constructor(private readonly options: QueryOptions = {}) {
    this.timeout = options.timeoutMs ?? 2000;
    if (
      this.timeout < 50 ||
      this.timeout > 10000 ||
      !Number.isFinite(this.timeout)
    )
      throw new Error("WINDOW_QUERY_TIMEOUT_INVALID");
  }
  private fail() {
    this.failed = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WINDOW_QUERY_UNAVAILABLE"));
    }
    this.child?.kill();
  }
  private start() {
    if (this.failed) throw new Error("WINDOW_QUERY_UNAVAILABLE");
    if (this.child) return this.child;
    const child = this.options.spawnProcess
      ? this.options.spawnProcess(script)
      : spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { windowsHide: true, stdio: "pipe" },
        );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        if (this.child === child) {
          this.fail();
          this.child = null;
        }
        resolve();
      });
      child.once("error", () => {
        if (this.child === child) {
          this.fail();
          if (!child.pid) this.child = null;
        }
        if (!child.pid) resolve();
      });
    });
    child.stdin.on("error", () => this.fail());
    child.stdout.on("data", (value: string) => {
      this.buffered += value;
      if (this.buffered.length > 65536) {
        this.fail();
        return;
      }
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      const pending = this.pending;
      if (!pending || this.buffered.trim()) {
        this.fail();
        return;
      }
      try {
        const data = JSON.parse(line) as {
          ok?: unknown;
          observation?: unknown;
        };
        if (data.ok !== true) throw new Error("WINDOW_QUERY_UNAVAILABLE");
        const info = data.observation as ActiveWindowInfo | null;
        if (
          info !== null &&
          (!info ||
            typeof info.application !== "string" ||
            info.application.length < 1 ||
            info.application.length > 255 ||
            typeof info.windowTitle !== "string" ||
            info.windowTitle.length > 2048)
        )
          throw new Error("WINDOW_QUERY_INVALID");
        this.pending = null;
        clearTimeout(pending.timer);
        pending.resolve(info);
      } catch {
        this.fail();
      }
    });
    return child;
  }
  getActiveWindow(
    excludedApplications: readonly string[] = [],
  ): Promise<ActiveWindowInfo | null> {
    if (this.pending) return Promise.reject(new Error("WINDOW_QUERY_BUSY"));
    if (
      excludedApplications.length > 1000 ||
      excludedApplications.some(
        (item) => typeof item !== "string" || item.length > 255,
      )
    )
      return Promise.reject(new Error("WINDOW_QUERY_INVALID"));
    try {
      const child = this.start();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.fail(), this.timeout);
        this.pending = { resolve, reject, timer };
        child.stdin.write(
          JSON.stringify({ excludedApplications }) + "\n",
          (error) => {
            if (error) this.fail();
          },
        );
      });
    } catch {
      return Promise.reject(new Error("WINDOW_QUERY_UNAVAILABLE"));
    }
  }
  async close(): Promise<void> {
    if (this.child) {
      this.fail();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const done = await Promise.race([
          this.exited.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 1000);
          }),
        ]);
        if (!done) throw new Error("WINDOW_HELPER_CLOSE_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
      }
    }
    this.failed = false;
    this.buffered = "";
  }
}
