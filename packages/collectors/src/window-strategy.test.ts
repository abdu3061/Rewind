import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { WindowsWindowQueryStrategy } from "./window-strategy";

const runner = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify: utilPromisify } = await import("node:util");
  return {
    ...actual,
    execFile: Object.assign(() => {}, { [utilPromisify.custom]: runner }),
  };
});
it("reports child-process failure without echoing upstream diagnostic text", async () => {
  runner.mockRejectedValueOnce(new Error("Synthetic private diagnostic"));
  await expect(
    new WindowsWindowQueryStrategy().getActiveWindow(),
  ).rejects.toThrow("WINDOW_QUERY_UNAVAILABLE");
});

it.runIf(process.platform === "win32")(
  "queries a synthetic window without assigning a PowerShell automatic variable",
  async () => {
    const actual =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    const syntheticWindow = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
public class ActiveWindow {
    public static IntPtr GetForegroundWindow() { return new IntPtr(1); }
    public static int GetWindowText(IntPtr handle, StringBuilder text, int size) {
        text.Append("Synthetic audit window"); return text.Length;
    }
    public static uint GetWindowThreadProcessId(IntPtr handle, out uint processId) {
        processId = (uint)System.Diagnostics.Process.GetCurrentProcess().Id; return 1;
    }
}
'@
`;
    runner.mockImplementation(async (_file: string, args: string[]) => {
      const script = args.at(-1);
      if (!script) throw new Error("Missing window-query script.");
      // The stub replaces every window API before the production script runs.
      // Only this child PowerShell process and synthetic text are observed.
      return promisify(actual.execFile)(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", syntheticWindow + script],
        { timeout: 10_000, windowsHide: true },
      );
    });
    expect(
      await new WindowsWindowQueryStrategy().getActiveWindow(),
    ).toMatchObject({
      windowTitle: "Synthetic audit window",
    });
  },
  15_000,
);
