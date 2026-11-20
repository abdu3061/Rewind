export interface ActiveWindowInfo {
  application: string;
  windowTitle: string;
}
export interface WindowQueryStrategy {
  /** null means no observation; failures reject and must not masquerade as readiness. */
  getActiveWindow(
    excludedApplications?: readonly string[],
  ): Promise<ActiveWindowInfo | null>;
  /** Release native helpers on pause/end. A failed close must reject. */
  close?(): Promise<void>;
}
export interface WindowsCollectorOptions {
  strategy?: WindowQueryStrategy;
  pollIntervalMs?: number;
  newId?: () => string;
  now?: () => string;
}
