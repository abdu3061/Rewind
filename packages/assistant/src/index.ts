export type {
  AssistantApprovedRequest,
  AssistantEvidence,
  EvidenceAnswer,
} from "@rewind/contracts";
export {
  GeminiEvidenceAssistant,
  geminiEvidenceModel,
  type GeminiEvidenceOptions,
} from "./gemini-evidence";
// No desktop composition or cloud permission is implied by this private service export.
export const assistantImplementationStatus =
  "approved-evidence-foundation" as const;
