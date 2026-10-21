import type { Repositories, Result, Timestamp } from '@rewind/contracts';

/** A future encrypted adapter must satisfy this interface. No database is opened today. */
export interface StorageAdapter {
  readonly repositories: Repositories;
  open(): Promise<Result<void>>;
  close(): Promise<Result<void>>;
  usage(): Promise<Result<{ metadataBytes: number; snapshotBytes: number }>>;
}

export interface RetentionReport {
  expiredBefore: Timestamp;
  removedRecords: number;
  removedBlobs: number;
  retainedKeptCheckpoints: number;
}

export const storageImplementationStatus = 'not-implemented' as const;
