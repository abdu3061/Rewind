import {
  failure,
  type Repositories,
  type Result,
  type UserSettings,
} from "@rewind/contracts";
import type { GoogleGenAI, GenerateContentResponse, Part } from "@google/genai";
import type { AssistantService, EvidenceAnswer } from "./index";
import {
  toolGetFileVersions,
  toolSearchActivity,
  toolSearchFiles,
  toolSearchWebsites,
  type AssistantToolContext,
} from "./tools";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOOL_ROUNDS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = "gemini-2.0-flash";

// ---------------------------------------------------------------------------
// Gemini function declarations for the tool loop
// ---------------------------------------------------------------------------

const TOOL_DECLARATIONS = [
  {
    name: "search_activity",
    description:
      "Search session activity events (foreground applications, idle/lock events, file changes) by keyword. Returns narrow summaries without raw database content.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Keyword to search for in activity events",
        },
        sessionId: {
          type: "string",
          description: "Optional session UUID to scope the search",
        },
        from: {
          type: "string",
          description:
            "Optional ISO 8601 start timestamp (e.g. 2026-11-16T10:00:00.000Z)",
        },
        to: {
          type: "string",
          description: "Optional ISO 8601 end timestamp",
        },
        limit: {
          type: "number",
          description: "Max results (1–20)",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "search_websites",
    description:
      "Search browser visit history by keyword. Returns narrow summaries: title, excerpt, timestamp.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Keyword to search browser visits",
        },
        sessionId: {
          type: "string",
          description: "Optional session UUID to scope the search",
        },
        from: {
          type: "string",
          description: "Optional ISO 8601 start timestamp",
        },
        to: { type: "string", description: "Optional ISO 8601 end timestamp" },
        limit: { type: "number", description: "Max results (1–20)" },
      },
      required: ["text"],
    },
  },
  {
    name: "search_files",
    description:
      "Search file activity (opened, changed files) by keyword. Returns narrow summaries: display name, evidence type, timestamp.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Keyword to search file activity",
        },
        sessionId: {
          type: "string",
          description: "Optional session UUID to scope the search",
        },
        from: {
          type: "string",
          description: "Optional ISO 8601 start timestamp",
        },
        to: { type: "string", description: "Optional ISO 8601 end timestamp" },
        limit: { type: "number", description: "Max results (1–20)" },
      },
      required: ["text"],
    },
  },
  {
    name: "get_file_versions",
    description:
      "List captured file versions for a known file ID. Returns version metadata (ID, capture time, type, size) — no file content or paths.",
    parameters: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "UUID of the file reference",
        },
        limit: { type: "number", description: "Max results (1–20)" },
      },
      required: ["fileId"],
    },
  },
];

const SYSTEM_INSTRUCTION = `You are Rewind, a local session-memory assistant.
You help users recall what they did during their work sessions by searching their local activity history.
Rules you must follow:
1. Only cite evidence that tools actually returned — never invent file names, URLs, or timestamps.
2. If tools return no matching evidence, say so clearly; do not guess or fabricate.
3. You have no ability to execute recovery, modify files, or access the internet.
4. Do not expose raw database IDs, internal hashes, or absolute file paths to the user.
5. When evidence quality is "title-only", disclose that the match is unverified.
6. Keep answers concise and grounded in the retrieved evidence.`;

// ---------------------------------------------------------------------------
// Options and service
// ---------------------------------------------------------------------------

export interface GeminiAssistantOptions {
  apiKey: string;
  repositories: Repositories;
  settings: UserSettings;
  model?: string;
}

export class GeminiAssistantService implements AssistantService {
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly ctx: AssistantToolContext;
  private readonly settings: UserSettings;

  constructor(options: GeminiAssistantOptions) {
    this.apiKey = options.apiKey;
    this.modelName = options.model ?? DEFAULT_MODEL;
    this.settings = options.settings;
    this.ctx = { repositories: options.repositories };
  }

  async ask(question: string): Promise<Result<EvidenceAnswer>> {
    if (!this.settings.cloudAiEnabled) {
      return failure(
        "FORBIDDEN",
        "Cloud AI is disabled. Enable it in settings to use the assistant.",
      );
    }
    if (typeof question !== "string" || question.trim().length === 0) {
      return failure("INVALID_INPUT", "Question must be a non-empty string.");
    }
    if (question.length > 2000) {
      return failure(
        "INVALID_INPUT",
        "Question must not exceed 2000 characters.",
      );
    }

    // Dynamic import keeps @google/genai out of the main bundle when disabled
    let GenAI: typeof GoogleGenAI;
    try {
      const mod = await import("@google/genai");
      GenAI = mod.GoogleGenAI;
    } catch {
      return failure(
        "UNAVAILABLE",
        "Gemini SDK is not available. Install @google/genai and restart.",
      );
    }

    try {
      const client = new GenAI({ apiKey: this.apiKey });

      type ContentItem = { role: string; parts: Part[] };
      const contents: ContentItem[] = [
        { role: "user", parts: [{ text: question.trim() }] },
      ];

      let responseText = "";

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const responsePromise = client.models.generateContent({
          model: this.modelName,
          contents,
          config: {
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            systemInstruction: SYSTEM_INSTRUCTION,
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Request timed out")),
            REQUEST_TIMEOUT_MS,
          ),
        );

        const response: GenerateContentResponse = await Promise.race([
          responsePromise,
          timeoutPromise,
        ]);

        const candidate = response.candidates?.[0];
        if (!candidate?.content) {
          responseText = "No response from assistant.";
          break;
        }

        const parts = candidate.content.parts ?? [];
        const functionCalls = parts.filter(
          (
            p,
          ): p is {
            functionCall: { name: string; args: Record<string, unknown> };
          } => "functionCall" in p && p.functionCall !== undefined,
        );
        const textParts = parts.filter(
          (p): p is { text: string } =>
            "text" in p &&
            typeof (p as Record<string, unknown>).text === "string",
        );

        if (functionCalls.length === 0) {
          responseText = textParts
            .map((p) => p.text)
            .join("")
            .trim();
          break;
        }

        // Add model turn to history before tool responses
        contents.push({ role: "model", parts });

        const functionResponseParts: Part[] = [];
        for (const part of functionCalls) {
          const { name, args } = part.functionCall;
          const toolResult = await this.dispatchTool(name, args);
          functionResponseParts.push({
            functionResponse: {
              name,
              response: toolResult.ok
                ? { result: toolResult.value }
                : { error: toolResult.error.message },
            },
          });
        }

        contents.push({ role: "user", parts: functionResponseParts });
      }

      if (!responseText) {
        responseText =
          "The assistant could not produce a final answer within the allowed tool rounds.";
      }

      const lc = responseText.toLowerCase();
      const insufficientEvidence =
        lc.includes("no evidence") ||
        lc.includes("not found") ||
        lc.includes("no matching") ||
        lc.includes("no record") ||
        lc.includes("could not find");

      return {
        ok: true,
        value: {
          text: responseText,
          sources: [],
          insufficientEvidence,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return failure("INTERNAL", `Assistant request failed: ${msg}`);
    }
  }

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Result<unknown>> {
    switch (name) {
      case "search_activity":
        return toolSearchActivity(this.ctx, args);
      case "search_websites":
        return toolSearchWebsites(this.ctx, args);
      case "search_files":
        return toolSearchFiles(this.ctx, args);
      case "get_file_versions":
        return toolGetFileVersions(this.ctx, args);
      default:
        return failure("NOT_FOUND", `Unknown tool: ${name}`);
    }
  }
}
