import { z } from "zod";
import { resultSchema, type Result } from "./common";
import { sessionStateSchema, type SessionState } from "./session";
import type { ActivityEvent } from "./activity";
import type { Session } from "./session";
import type { BrowserControlState } from "./browser-controls";
import type {
  AssistantControlState,
  AssistantReviewReceipt,
  AssistantAnswerReceipt,
} from "./assistant-controls";
import type { AssistantReviewApproval } from "./assistant";
import type { ProtectedFolder } from "./snapshots";
import type { FileVersion } from "./files";
import type { RecoveryCopyProposal, RecoveryCopyResult } from "./recovery";
import type {
  RecoveryOverwriteProposal,
  RecoveryOverwriteResult,
} from "./recovery-overwrite";
import type { Checkpoint } from "./files";
import type {
  CheckpointCreate,
  CheckpointListQuery,
  CheckpointSummary,
  CheckpointView,
  CheckpointUpdate,
} from "./checkpoint-controls";
import type {
  FileProtectionState,
  VersionListQuery,
  CapturedVersionSummary,
  VersionPreview,
} from "./file-controls";
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

// Only implemented capabilities are public. Paths are selected by native dialogs in main.
export interface DesktopApi {
  assistant: {
    state(): Promise<Result<AssistantControlState>>;
    configure(confirmed: true): Promise<Result<AssistantControlState | null>>;
    permission(enabled: boolean): Promise<Result<AssistantControlState>>;
    forget(confirmed: true): Promise<Result<AssistantControlState>>;
    prepare(value: {
      question: string;
      activityIds: string[];
    }): Promise<Result<AssistantReviewReceipt>>;
    ask(
      value: AssistantReviewApproval,
    ): Promise<Result<AssistantAnswerReceipt>>;
    cancel(id: string): Promise<Result<true>>;
    stop(): Promise<Result<true>>;
  };
  browser: {
    openExtensionFolder(): Promise<Result<true>>;
    state(): Promise<Result<BrowserControlState>>;
    install(
      browsers: ("chrome" | "edge")[],
      confirmed: true,
    ): Promise<Result<BrowserControlState>>;
    remove(
      browser: "chrome" | "edge",
      confirmed: true,
    ): Promise<Result<BrowserControlState>>;
    repair(confirmed: true): Promise<Result<BrowserControlState>>;
    permission(enabled: boolean): Promise<Result<BrowserControlState>>;
    exclusions(hosts: string[]): Promise<Result<BrowserControlState>>;
  };
  checkpoints: {
    create(value: CheckpointCreate): Promise<Result<Checkpoint>>;
    list(query: CheckpointListQuery): Promise<Result<CheckpointSummary[]>>;
    view(id: string): Promise<Result<CheckpointView>>;
    update(value: CheckpointUpdate): Promise<Result<Checkpoint>>;
    delete(id: string, confirmed: true): Promise<Result<true>>;
  };
  recovery: {
    chooseOverwrite(
      versionId: string,
    ): Promise<Result<RecoveryOverwriteProposal | null>>;
    confirmOverwrite(
      proposalId: string,
      confirmed: true,
    ): Promise<Result<RecoveryOverwriteResult>>;
    chooseCopy(versionId: string): Promise<Result<RecoveryCopyProposal | null>>;
    confirmCopy(
      proposalId: string,
      confirmed: true,
    ): Promise<Result<RecoveryCopyResult>>;
    cancel(proposalId: string): Promise<Result<true>>;
  };
  files: {
    state(): Promise<Result<FileProtectionState>>;
    selectFolder(): Promise<Result<ProtectedFolder | null>>;
    permission(enabled: boolean): Promise<Result<FileProtectionState>>;
    removeFolder(id: string): Promise<Result<FileProtectionState>>;
  };
  versions: {
    info(id: string): Promise<Result<FileVersion | null>>;
    list(query: VersionListQuery): Promise<Result<CapturedVersionSummary[]>>;
    preview(id: string): Promise<Result<VersionPreview>>;
  };
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
