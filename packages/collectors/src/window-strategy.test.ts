import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { WindowsWindowQueryStrategy } from "./window-strategy";

const strategies: WindowsWindowQueryStrategy[] = [];
afterEach(async () => {
  for (const strategy of strategies.splice(0)) await strategy.close();
});
function fixture(
  options: ConstructorParameters<typeof WindowsWindowQueryStrategy>[0],
) {
  const strategy = new WindowsWindowQueryStrategy(options);
  strategies.push(strategy);
  return strategy;
}
it("reports child failure and timeouts without upstream diagnostics or leaving a helper", async () => {
  const failed = fixture({
    spawnProcess: () =>
      spawn(
        process.execPath,
        [
          "-e",
          "console.error('Synthetic private diagnostic'); process.exit(1)",
        ],
        { stdio: "pipe", windowsHide: true },
      ),
  });
  await expect(failed.getActiveWindow()).rejects.toThrow(
    "WINDOW_QUERY_UNAVAILABLE",
  );
  let child: ReturnType<typeof spawn> | undefined;
  const hung = fixture({
    timeoutMs: 100,
    spawnProcess: () => {
      const processChild = spawn(
        process.execPath,
        ["-e", "process.stdin.resume()"],
        { stdio: "pipe", windowsHide: true },
      );
      child = processChild;
      return processChild;
    },
  });
  await expect(hung.getActiveWindow()).rejects.toThrow(
    "WINDOW_QUERY_UNAVAILABLE",
  );
  await hung.close();
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
});
it.runIf(process.platform === "win32")(
  "treats a foreground process that exited during lookup as no observation and keeps the helper usable",
  async () => {
    const stub = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
public class ActiveWindow {
  static int count = 0;
  public static IntPtr GetForegroundWindow() { return new IntPtr(1); }
  public static int GetWindowText(IntPtr handle, StringBuilder text, int size) { text.Append("Synthetic surviving window"); return text.Length; }
  public static uint GetWindowThreadProcessId(IntPtr handle, out uint processId) { processId = ++count==1 ? 2147483647u : (uint)System.Diagnostics.Process.GetCurrentProcess().Id; return 1; }
}
'@
`;
    const strategy = fixture({
      timeoutMs: 8000,
      spawnProcess: (script) =>
        spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(stub + script, "utf16le").toString("base64"),
          ],
          { stdio: "pipe", windowsHide: true },
        ),
    });
    expect(await strategy.getActiveWindow()).toBeNull();
    expect(await strategy.getActiveWindow()).toMatchObject({
      application: "powershell",
      windowTitle: "Synthetic surviving window",
    });
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "reuses one real PowerShell helper and excludes before any title read",
  async () => {
    let starts = 0;
    const stub = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
public class ActiveWindow {
  static int count = 0;
  public static IntPtr GetForegroundWindow() { return new IntPtr(1); }
  public static int GetWindowText(IntPtr handle, StringBuilder text, int size) { count++; text.Append("Synthetic title " + count); return text.Length; }
  public static uint GetWindowThreadProcessId(IntPtr handle, out uint processId) { processId = (uint)System.Diagnostics.Process.GetCurrentProcess().Id; return 1; }
}
'@
`;
    const strategy = fixture({
      timeoutMs: 8000,
      spawnProcess: (script) => {
        starts++;
        // Every user32 call is replaced before the production helper is evaluated.
        return spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(stub + script, "utf16le").toString("base64"),
          ],
          { stdio: "pipe", windowsHide: true },
        );
      },
    });
    expect(await strategy.getActiveWindow()).toMatchObject({
      application: "powershell",
      windowTitle: "Synthetic title 1",
    });
    expect(await strategy.getActiveWindow(["PowerShell.exe"])).toBeNull();
    expect(await strategy.getActiveWindow()).toMatchObject({
      windowTitle: "Synthetic title 2",
    });
    expect(starts).toBe(1);
    await strategy.close();
    expect(await strategy.getActiveWindow()).toMatchObject({
      windowTitle: "Synthetic title 1",
    });
    expect(starts).toBe(2);
  },
  20000,
);
