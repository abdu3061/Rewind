import type {
  FileVersion,
  Id,
  RecoveryProposal,
  Result,
  SearchQuery,
  SearchResult,
  SourceReference,
} from "@rewind/contracts";

/** Validated tools available to a future bounded assistant; deliberately no execute_recovery. */
export interface AssistantTools {
  search_activity(query: SearchQuery): Promise<Result<SearchResult[]>>;
  search_websites(query: SearchQuery): Promise<Result<SearchResult[]>>;
  search_files(query: SearchQuery): Promise<Result<SearchResult[]>>;
  get_file_versions(fileId: Id): Promise<Result<FileVersion[]>>;
  search_checkpoints(query: SearchQuery): Promise<Result<SearchResult[]>>;
  propose_recovery(fileVersionId: Id): Promise<Result<RecoveryProposal>>;
}

export interface EvidenceAnswer {
  text: string;
  sources: SourceReference[];
  insufficientEvidence: boolean;
}

export interface AssistantService {
  ask(question: string): Promise<Result<EvidenceAnswer>>;
}

export const assistantImplementationStatus = "gemini-tool-loop" as const;

export { GeminiAssistantService } from "./gemini-service";
export type { GeminiAssistantOptions } from "./gemini-service";
