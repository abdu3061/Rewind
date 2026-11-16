export type {
  Collector,
  CollectorContext,
  CollectorRegistry,
} from "@rewind/contracts";
export { WindowsCollector } from "./windows-collector";
export type {
  ActiveWindowInfo,
  WindowQueryStrategy,
  WindowsCollectorOptions,
} from "./types";

// A Windows prototype exists; the desktop registers no native collectors or watchers.
export const collectorImplementationStatus = "prototype-unintegrated" as const;
