import { win32 } from "node:path";
import type { ActivityEvent, UserSettings } from "@rewind/contracts";

export function isExcludedPath(
  file: string,
  roots: readonly string[],
): boolean {
  return roots.some((root) => {
    const relative = win32.relative(root.toLowerCase(), file.toLowerCase());
    return (
      !relative ||
      (!relative.startsWith("..\\") &&
        relative !== ".." &&
        !win32.isAbsolute(relative))
    );
  });
}

/** Exclusions are additional denials, never proof of canonical path/site authorization. */
export function isExcluded(
  event: ActivityEvent,
  settings: UserSettings,
): boolean {
  if (event.type === "foreground") {
    const app = event.payload.application.toLowerCase().replace(/\.exe$/, "");
    return (
      ["chrome", "msedge", "firefox", "brave", "opera", "rewind"].includes(
        app,
      ) ||
      settings.excludedApplications.some(
        (item) => item.toLowerCase().replace(/\.exe$/, "") === app,
      )
    );
  }
  if (event.type === "browser-visit") {
    const host = new URL(event.payload.url).hostname
      .toLowerCase()
      .replace(/\.$/, "");
    return settings.excludedSiteHosts.some((item) => {
      const excluded = item.trim().toLowerCase().replace(/\.$/, "");
      return host === excluded || host.endsWith(`.${excluded}`);
    });
  }
  if (
    event.type === "file-opened" &&
    event.payload.identity.kind === "verified-path"
  ) {
    return isExcludedPath(
      event.payload.identity.absolutePath,
      settings.excludedFolderPaths,
    );
  }
  return false;
}
