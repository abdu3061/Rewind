import type { Collector } from '@rewind/contracts';

export type { Collector, CollectorContext } from '@rewind/contracts';
export interface CollectorRegistry {
  windows: Collector;
  browser: Collector;
  folders: Collector;
}

// No OS APIs, timers, watchers, or extension ports are registered by this package.
export const collectorImplementationStatus = 'not-implemented' as const;
