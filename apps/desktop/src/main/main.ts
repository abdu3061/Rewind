import { app, dialog, protocol } from "electron";
import { handleInstallerStartup } from "./installer-startup";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "rewind",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// Keep installer execution ahead of imports that construct services or read a profile.
void handleInstallerStartup({
  packaged: app.isPackaged,
  platform: process.platform,
  executable: process.execPath,
  argument: process.argv[1],
})
  .then(async (handled) => {
    if (handled) app.exit(0);
    else await import("./desktop");
  })
  .catch(() => {
    console.error(
      JSON.stringify({ level: "error", code: "DESKTOP_BOOT_FAILED" }),
    );
    dialog.showErrorBox(
      "Rewind could not start",
      "Startup could not be completed (DESKTOP_BOOT_FAILED). Your saved history has not been reset. Reinstall the same or a newer version and retry.",
    );
    app.exit(1);
  });
