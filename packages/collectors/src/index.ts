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

// Only Windows foreground collection is composed; browser and folder adapters remain unavailable.
export const collectorImplementationStatus = "windows-consent-gated" as const;
