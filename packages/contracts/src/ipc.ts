import { z } from 'zod';
import { resultSchema, type Result } from './common';
import { sessionStateSchema, type SessionState } from './session';

export const SESSION_CHANNEL = 'rewind:session' as const;
export const SESSION_CHANGED_CHANNEL = 'rewind:session-changed' as const;
export const sessionResponseSchema = resultSchema(sessionStateSchema);
export const noArgumentsSchema = z.tuple([]);

// Only implemented capabilities are public. Recovery/AI/filesystem IPC will need lead review.
export interface DesktopApi {
  sessions: {
    get(): Promise<Result<SessionState>>;
    start(): Promise<Result<SessionState>>;
    pause(): Promise<Result<SessionState>>;
    resume(): Promise<Result<SessionState>>;
    end(): Promise<Result<SessionState>>;
    onChanged(listener: (state: SessionState) => void): () => void;
  };
}
