import path from "node:path";
import { spawn } from "node:child_process";

const events = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);

/** Installer invocations never open history, request keys, or start a worker. */
export async function handleInstallerStartup(options: {
  packaged: boolean;
  platform: string;
  executable: string;
  argument: string | undefined;
  update?: (executable: string, args: string[]) => Promise<void>;
}): Promise<boolean> {
  if (
    !options.packaged ||
    options.platform !== "win32" ||
    !events.has(options.argument ?? "")
  )
    return false;
  if (options.argument === "--squirrel-obsolete") return true;
  const directory = path.dirname(options.executable);
  if (
    path.basename(options.executable) !== "Rewind.exe" ||
    !/^app-\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(path.basename(directory))
  )
    throw new Error("INSTALLER_LAYOUT_INVALID");
  const command =
    options.argument === "--squirrel-uninstall"
      ? "--removeShortcut"
      : "--createShortcut";
  await (options.update ?? runUpdate)(
    path.resolve(directory, "..", "Update.exe"),
    [command, "Rewind.exe", "--shortcut-locations", "StartMenu,Desktop"],
  );
  return true;
}

function runUpdate(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("INSTALLER_SHORTCUT_TIMEOUT"));
    }, 8000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("INSTALLER_SHORTCUT_FAILED"));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("INSTALLER_SHORTCUT_FAILED"));
    });
  });
}
