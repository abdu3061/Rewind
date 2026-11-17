import { z } from "zod";
import { resultSchema, type Result } from "./common";
import { sessionStateSchema, type SessionState } from "./session";

export const SESSION_CHANNEL = "rewind:session" as const;
export const SESSION_CHANGED_CHANNEL = "rewind:session-changed" as const;
export const ASSISTANT_CHANNEL = "rewind:assistant" as const;

export const sessionResponseSchema = resultSchema(sessionStateSchema);
export const noArgumentsSchema = z.tuple([]);

export const askQuestionSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
});
export type AskQuestion = z.infer<typeof askQuestionSchema>;

/** Narrow evidence answer transmitted over IPC — no raw DB rows or file paths. */
export const evidenceAnswerSchema = z.strictObject({
  text: z.string().min(1).max(100_000),
  sources: z.array(z.unknown()).max(100),
  insufficientEvidence: z.boolean(),
});
export type EvidenceAnswerIpc = z.infer<typeof evidenceAnswerSchema>;

export const assistantResponseSchema = resultSchema(evidenceAnswerSchema);

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
  /**
   * Cloud AI assistant — only available when cloudAiEnabled is true in settings.
   * Returns FORBIDDEN when disabled; UNAVAILABLE when the SDK is not installed.
   */
  assistant: {
    ask(question: string): Promise<Result<EvidenceAnswerIpc>>;
  };
}
