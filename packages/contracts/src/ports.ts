import type { ActivityEvent } from './activity';
import type { Id, Result, Timestamp } from './common';
import type { Checkpoint, FileReference, FileVersion } from './files';
import type { SearchQuery, SearchResult } from './search';
import type { Session } from './session';
import type { UserSettings } from './settings';

export interface SessionRepository {
  save(session: Session): Promise<Result<void>>;
  get(id: Id): Promise<Result<Session | null>>;
  getLatest(): Promise<Result<Session | null>>;
}
export interface ActivityRepository {
  append(events: readonly ActivityEvent[]): Promise<Result<void>>;
  list(sessionId: Id, limit: number, before?: Timestamp): Promise<Result<ActivityEvent[]>>;
}
export interface FileRepository {
  getReference(fileId: Id): Promise<Result<FileReference | null>>;
  saveReference(file: FileReference): Promise<Result<void>>;
  addVersion(version: FileVersion): Promise<Result<void>>;
  getVersion(id: Id): Promise<Result<FileVersion | null>>;
  listVersions(fileId: Id): Promise<Result<FileVersion[]>>;
}
export interface CheckpointRepository {
  save(checkpoint: Checkpoint): Promise<Result<void>>;
  get(id: Id): Promise<Result<Checkpoint | null>>;
  list(sessionId: Id): Promise<Result<Checkpoint[]>>;
}
export interface SearchRepository {
  search(query: SearchQuery): Promise<Result<SearchResult[]>>;
}
export interface Repositories {
  sessions: SessionRepository;
  activities: ActivityRepository;
  files: FileRepository;
  checkpoints: CheckpointRepository;
  search: SearchRepository;
}

export interface CollectorContext {
  sessionId: Id;
  // Short-lived per-run generation; stale queued events must be rejected by the engine.
  generationId: Id;
  settings: Readonly<UserSettings>;
  emit(events: readonly ActivityEvent[]): Promise<Result<void>>;
}
export interface Collector {
  readonly id: string;
  start(context: CollectorContext): Promise<Result<void>>;
  pause(): Promise<Result<void>>;
  resume(context: CollectorContext): Promise<Result<void>>;
  stop(): Promise<Result<void>>;
}
