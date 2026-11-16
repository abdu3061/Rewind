import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActiveWindowInfo, WindowQueryStrategy } from "./types";
import { WindowsWindowQueryStrategy } from "./windows-query-process";
export { WindowsWindowQueryStrategy };
const execFileAsync = promisify(execFile);

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
