import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { handleInstallerStartup } from "./installer-startup";

const options = {
  packaged: true,
  platform: "win32",
  executable: path.resolve("synthetic-install", "app-0.1.0", "Rewind.exe"),
};
describe("passive installer startup", () => {
  it.each(["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall"])(
    "only manages fixed shortcuts for %s",
    async (argument) => {
      const update = vi.fn().mockResolvedValue(undefined);
      expect(
        await handleInstallerStartup({ ...options, argument, update }),
      ).toBe(true);
      expect(update).toHaveBeenCalledWith(
        path.resolve("synthetic-install", "Update.exe"),
        [
          argument === "--squirrel-uninstall"
            ? "--removeShortcut"
            : "--createShortcut",
          "Rewind.exe",
          "--shortcut-locations",
          "StartMenu,Desktop",
        ],
      );
    },
  );
  it("obsolete exits without reading or mutating profile data", async () => {
    const update = vi.fn();
    expect(
      await handleInstallerStartup({
        ...options,
        argument: "--squirrel-obsolete",
        update,
      }),
    ).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });
  it("does not treat first launch, unknown arguments or development as installation", async () => {
    const update = vi.fn();
    for (const argument of [
      undefined,
      "--squirrel-firstrun",
      "--squirrel-install=anything",
    ])
      expect(
        await handleInstallerStartup({ ...options, argument, update }),
      ).toBe(false);
    expect(
      await handleInstallerStartup({
        ...options,
        packaged: false,
        argument: "--squirrel-install",
        update,
      }),
    ).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
  it("rejects an unexpected layout and propagates shortcut failure", async () => {
    const update = vi.fn().mockRejectedValue(new Error("synthetic failure"));
    await expect(
      handleInstallerStartup({
        ...options,
        executable: path.resolve("Rewind.exe"),
        argument: "--squirrel-install",
        update,
      }),
    ).rejects.toThrow("INSTALLER_LAYOUT_INVALID");
    expect(update).not.toHaveBeenCalled();
    await expect(
      handleInstallerStartup({
        ...options,
        argument: "--squirrel-uninstall",
        update,
      }),
    ).rejects.toThrow("synthetic failure");
  });
});
