import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActiveWindowInfo, WindowQueryStrategy } from "./types";

const execFileAsync = promisify(execFile);

const WINDOWS_POWERSHELL_SCRIPT = `
try {
    $code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class ActiveWindow {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
'@
    if (-not ([System.Management.Automation.PSTypeName]'ActiveWindow').Type) {
        Add-Type -TypeDefinition $code -Language CSharp -ErrorAction SilentlyContinue
    }

    if (([System.Management.Automation.PSTypeName]'ActiveWindow').Type) {
        $hwnd = [ActiveWindow]::GetForegroundWindow()
        if ($hwnd -and $hwnd -ne [IntPtr]::Zero) {
            [uint32]$foregroundProcessId = 0
            [ActiveWindow]::GetWindowThreadProcessId($hwnd, [ref]$foregroundProcessId) | Out-Null
            if ($foregroundProcessId -gt 0) {
                $proc = Get-Process -Id $foregroundProcessId -ErrorAction SilentlyContinue
                if (-not $proc) { exit 1 }
                $appName = if ($proc) { $proc.ProcessName } else { "unknown" }
                $title = ""
                # A generic browser window cannot prove nonprivate context. Do not read its title.
                if ($appName.ToLowerInvariant() -notin @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'rewind')) {
                    $sb = New-Object System.Text.StringBuilder 2048
                    [ActiveWindow]::GetWindowText($hwnd, $sb, 2048) | Out-Null
                    $title = $sb.ToString()
                }
                Write-Output "$appName\`t$title"
            }
        }
    } else { exit 1 }
} catch {
    # In headless CI or if user32 / Add-Type fails, exit cleanly without writing to stderr
    exit 1
}
`.trim();

export class WindowsWindowQueryStrategy implements WindowQueryStrategy {
  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_POWERSHELL_SCRIPT,
        ],
        { timeout: 2000, windowsHide: true, maxBuffer: 64 * 1024 },
      );

      const trimmed = stdout.trim();
      if (!trimmed) return null;

      const tabIndex = trimmed.indexOf("\t");
      if (tabIndex === -1) {
        return { application: trimmed.slice(0, 255), windowTitle: "" };
      }

      const application = trimmed.slice(0, tabIndex).trim().slice(0, 255);
      const windowTitle = trimmed
        .slice(tabIndex + 1)
        .trim()
        .slice(0, 2048);

      return {
        application: application || "unknown",
        windowTitle,
      };
    } catch {
      throw new Error("WINDOW_QUERY_UNAVAILABLE");
    }
  }
}

const DARWIN_APPLESCRIPT = `
tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set appName to name of frontApp
    set winTitle to ""
    try
        tell frontApp
            set winTitle to name of front window
        end tell
    end try
    return appName & tab & winTitle
end tell
`.trim();

export class DarwinWindowQueryStrategy implements WindowQueryStrategy {
  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", DARWIN_APPLESCRIPT],
        { timeout: 2000 },
      );

      const trimmed = stdout.trim();
      if (!trimmed) return null;

      const tabIndex = trimmed.indexOf("\t");
      if (tabIndex === -1) {
        return { application: trimmed.slice(0, 255), windowTitle: "" };
      }

      const application = trimmed.slice(0, tabIndex).trim().slice(0, 255);
      const windowTitle = trimmed
        .slice(tabIndex + 1)
        .trim()
        .slice(0, 2048);

      return {
        application: application || "unknown",
        windowTitle,
      };
    } catch {
      throw new Error("WINDOW_QUERY_UNAVAILABLE");
    }
  }
}

export class MockWindowQueryStrategy implements WindowQueryStrategy {
  private current: ActiveWindowInfo | null = null;
  public queryCount = 0;

  constructor(initial: ActiveWindowInfo | null = null) {
    this.current = initial;
  }

  setActiveWindow(info: ActiveWindowInfo | null): void {
    this.current = info;
  }

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    this.queryCount++;
    return this.current ? { ...this.current } : null;
  }
}

export class NullWindowQueryStrategy implements WindowQueryStrategy {
  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    return null;
  }
}

export function createDefaultWindowQueryStrategy(): WindowQueryStrategy {
  if (process.platform === "win32") {
    return new WindowsWindowQueryStrategy();
  }
  if (process.platform === "darwin") {
    return new DarwinWindowQueryStrategy();
  }
  return {
    getActiveWindow: async () => {
      throw new Error("WINDOW_QUERY_UNSUPPORTED");
    },
  };
}
