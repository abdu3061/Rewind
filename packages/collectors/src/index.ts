import type { CollectorRegistry } from "@rewind/contracts";
import { BrowserCollector } from "./browser-collector";
import { FolderCollector } from "./folder-collector";
import type { CollectorRegistryOptions } from "./types";
import { WindowsCollector } from "./windows-collector";

export type {
  Collector,
  CollectorContext,
  CollectorRegistry,
} from "@rewind/contracts";
export * from "./types";
export * from "./window-strategy";
export * from "./windows-collector";
export * from "./browser-collector";
export * from "./folder-collector";

export function createCollectorRegistry(
  options: CollectorRegistryOptions = {},
): CollectorRegistry {
  const windows = new WindowsCollector({
    ...(options.windowStrategy !== undefined
      ? { strategy: options.windowStrategy }
      : {}),
    ...(options.windowPollIntervalMs !== undefined
      ? { pollIntervalMs: options.windowPollIntervalMs }
      : {}),
    ...(options.newId !== undefined ? { newId: options.newId } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const browser = new BrowserCollector({
    ...(options.newId !== undefined ? { newId: options.newId } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const folders = new FolderCollector({
    ...(options.watchRoots !== undefined
      ? { watchRoots: options.watchRoots }
      : {}),
    ...(options.newId !== undefined ? { newId: options.newId } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  return { windows, browser, folders };
}

export const collectorImplementationStatus = "implemented" as const;
