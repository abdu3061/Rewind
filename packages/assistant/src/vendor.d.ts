/**
 * Minimal type declaration for @google/genai so TypeScript can resolve the
 * dynamic import in gemini-service.ts without the package being installed.
 * At runtime the actual installed package (or a "UNAVAILABLE" error) is used.
 */
declare module "@google/genai" {
  export interface FunctionCallPart {
    functionCall: { name: string; args: Record<string, unknown> };
  }
  export interface FunctionResponsePart {
    functionResponse: { name: string; response: unknown };
  }
  export interface TextPart {
    text: string;
  }
  export type Part =
    | TextPart
    | FunctionCallPart
    | FunctionResponsePart
    | Record<string, unknown>;

  export interface Content {
    role: string;
    parts: Part[];
  }

  export interface Candidate {
    content?: Content;
    finishReason?: string;
  }

  export interface GenerateContentResponse {
    candidates?: Candidate[];
  }

  export interface GenerateContentParams {
    model: string;
    contents: Content[];
    config?: {
      tools?: unknown[];
      systemInstruction?: string;
    };
  }

  export class GoogleGenAI {
    constructor(options: { apiKey: string });
    readonly models: {
      generateContent(
        params: GenerateContentParams,
      ): Promise<GenerateContentResponse>;
    };
  }
}
