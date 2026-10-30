import type { ActivityEvent, ActivityType } from "./activity";
import type { Id, Result, Timestamp } from "./common";
import type { Checkpoint, FileReference, FileVersion } from "./files";
import type { SearchQuery, SearchResult } from "./search";
import type { Session } from "./session";
import type { UserSettings } from "./settings";

export interface TimelineQueryOptions {
  sessionId?: Id;
  types?: readonly ActivityType[];
  source?: ActivityEvent["source"];
  before?: Timestamp;
  after?: Timestamp;
  limit?: number;
  order?: "asc" | "desc";
}

export interface TimelineSummary {
  sessionId: Id;
  totalEvents: number;
  eventsByType: Partial<Record<ActivityType, number>>;
  firstEventAt: Timestamp | null;
  lastEventAt: Timestamp | null;
}

export interface FileVersionQueryOptions {
  sessionId?: Id;
  fileId?: Id;
  mediaType?: string;
  before?: Timestamp;
  after?: Timestamp;
  limit?: number;
  order?: "asc" | "desc";
}

export interface CheckpointQueryOptions {
  sessionId?: Id;
  keptOnly?: boolean;
  before?: Timestamp;
  after?: Timestamp;
  limit?: number;
  order?: "asc" | "desc";
}

export interface SessionRepository {
  save(session: Session): Promise<Result<void>>;
  get(id: Id): Promise<Result<Session | null>>;
  getLatest(): Promise<Result<Session | null>>;
  list?(limit?: number): Promise<Result<Session[]>>;
  delete?(id: Id): Promise<Result<void>>;
}

export interface ActivityRepository {
  append(events: readonly ActivityEvent[]): Promise<Result<void>>;
  list(
    sessionId: Id,
    limit: number,
    before?: Timestamp,
  ): Promise<Result<ActivityEvent[]>>;
  queryTimeline?(
    options: TimelineQueryOptions,
  ): Promise<Result<ActivityEvent[]>>;
  count?(sessionId: Id, type?: ActivityType): Promise<Result<number>>;
  getTimelineSummary?(sessionId: Id): Promise<Result<TimelineSummary>>;
}

export interface FileRepository {
  getReference(fileId: Id): Promise<Result<FileReference | null>>;
  saveReference(file: FileReference): Promise<Result<void>>;
  addVersion(version: FileVersion): Promise<Result<void>>;
  getVersion(id: Id): Promise<Result<FileVersion | null>>;
  listVersions(fileId: Id): Promise<Result<FileVersion[]>>;
  getLatestVersion?(fileId: Id): Promise<Result<FileVersion | null>>;
  listVersionsBySession?(
    sessionId: Id,
    limit?: number,
  ): Promise<Result<FileVersion[]>>;
  listReferences?(limit?: number): Promise<Result<FileReference[]>>;
  queryVersions?(
    options: FileVersionQueryOptions,
  ): Promise<Result<FileVersion[]>>;
  findVersionsByHash?(contentHash: string): Promise<Result<FileVersion[]>>;
}

export interface CheckpointRepository {
  save(checkpoint: Checkpoint): Promise<Result<void>>;
  get(id: Id): Promise<Result<Checkpoint | null>>;
  list(sessionId: Id): Promise<Result<Checkpoint[]>>;
  listKept?(sessionId?: Id): Promise<Result<Checkpoint[]>>;
  setKept?(id: Id, kept: boolean): Promise<Result<void>>;
  delete?(id: Id): Promise<Result<void>>;
  queryCheckpoints?(
    options: CheckpointQueryOptions,
  ): Promise<Result<Checkpoint[]>>;
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
