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

// Composition and source approval remain the desktop utility/coordinator's responsibility.
export const collectorImplementationStatus = "consent-gated-sources" as const;
export { WindowsProtectedFileAccess } from "./windows-file-access";
export { ProtectedFolderCollector } from "./protected-folder-collector";
export { WindowsRecoveryCopyWriter } from "./windows-copy-writer";
export { WindowsRecoveryOverwriteWriter } from "./windows-overwrite-writer";
