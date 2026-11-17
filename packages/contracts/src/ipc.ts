import { z } from "zod";
import { resultSchema, type Result } from "./common";
import { sessionStateSchema, type SessionState } from "./session";
import type { ActivityEvent } from "./activity";
import type { Session } from "./session";
import type {
  StoragePreferences,
  StorageUsage,
  DeleteHistory,
} from "./storage-management";
import type {
  CollectionPreferences,
  HistoryQuery,
  RuntimeSnapshot,
  TimelineQuery,
} from "./recording";

export const SESSION_CHANNEL = "rewind:session" as const;
export const SESSION_CHANGED_CHANNEL = "rewind:session-changed" as const;
export const sessionResponseSchema = resultSchema(sessionStateSchema);
export const noArgumentsSchema = z.tuple([]);

// Only implemented capabilities are public. Recovery/AI/filesystem IPC will need lead review.
export interface DesktopApi {
  storage: {
    usage(): Promise<Result<StorageUsage>>;
    update(value: StoragePreferences): Promise<Result<StorageUsage>>;
    cleanup(): Promise<Result<StorageUsage>>;
    deleteHistory(value: DeleteHistory): Promise<Result<StorageUsage>>;
  };
  runtime: {
    get(): Promise<Result<RuntimeSnapshot>>;
    retry(): Promise<Result<RuntimeSnapshot>>;
    onChanged(listener: (snapshot: RuntimeSnapshot) => void): () => void;
  };
  privacy: {
    get(): Promise<Result<CollectionPreferences>>;
    update(
      preferences: CollectionPreferences,
    ): Promise<Result<CollectionPreferences>>;
  };
  timeline: {
    query(query: TimelineQuery): Promise<Result<ActivityEvent[]>>;
    onChanged(listener: (sessionId: string) => void): () => void;
  };
  history: { list(query: HistoryQuery): Promise<Result<Session[]>> };
  sessions: {
    get(): Promise<Result<SessionState>>;
    start(): Promise<Result<SessionState>>;
    pause(): Promise<Result<SessionState>>;
    resume(): Promise<Result<SessionState>>;
    end(): Promise<Result<SessionState>>;
    onChanged(listener: (state: SessionState) => void): () => void;
  };
}
