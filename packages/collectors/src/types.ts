export interface ActiveWindowInfo {
  application: string;
  windowTitle: string;
}
export interface WindowQueryStrategy {
  /** null means no observation; failures reject and must not masquerade as readiness. */
  getActiveWindow(): Promise<ActiveWindowInfo | null>;
}
export interface WindowsCollectorOptions {
  strategy?: WindowQueryStrategy;
  pollIntervalMs?: number;
  newId?: () => string;
  now?: () => string;
}
