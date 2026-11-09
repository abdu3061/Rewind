export interface ActiveWindowInfo {
  application: string;
  windowTitle: string;
}

export interface WindowQueryStrategy {
  getActiveWindow(): Promise<ActiveWindowInfo | null>;
}

export interface WindowsCollectorOptions {
  strategy?: WindowQueryStrategy;
  pollIntervalMs?: number;
  newId?: () => string;
  now?: () => string;
}

export interface BrowserVisitInput {
  browser: "chrome" | "edge";
  url: string;
  title: string;
  visitedAt?: string;
  endedAt?: string | null;
  articleText?: string;
}

export interface BrowserCollectorOptions {
  newId?: () => string;
  now?: () => string;
}

export interface FolderCollectorOptions {
  watchRoots?: string[];
  debounceMs?: number;
  newId?: () => string;
  now?: () => string;
}

export interface CollectorRegistryOptions {
  windowStrategy?: WindowQueryStrategy;
  windowPollIntervalMs?: number;
  watchRoots?: string[];
  newId?: () => string;
  now?: () => string;
}
