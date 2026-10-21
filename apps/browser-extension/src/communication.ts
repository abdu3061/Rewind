import type { BrowserVisit, Result } from '@rewind/contracts';

/** Proposed Native Messaging adapter; no host connection is opened yet. */
export interface DesktopCommunicationAdapter {
  connect(): Promise<Result<void>>;
  sendVisit(visit: BrowserVisit, generationId: string): Promise<Result<void>>;
  disconnect(): Promise<void>;
}
export const NATIVE_HOST_NAME = 'com.rewind.bridge';
