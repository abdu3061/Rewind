import type { Repositories, Result, Timestamp } from "@rewind/contracts";

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

export * from './database-schema';
export * from './session-repository';
export * from './activity-repository';
export * from './file-repository';
export * from './checkpoint-repository';
export * from './search-repository';
export * from './sqlite-adapter';




