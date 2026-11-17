import { z } from "zod";
import {
  failure,
  idSchema,
  type FileVersion,
  type Id,
  type Repositories,
  type Result,
  type SearchResult,
} from "@rewind/contracts";

// ---------------------------------------------------------------------------
// Tool input schemas — strictly bounded so the model cannot inject large scans
// ---------------------------------------------------------------------------

export const searchActivityInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  sessionId: idSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export type SearchActivityInput = z.infer<typeof searchActivityInputSchema>;

export const searchWebsitesInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  sessionId: idSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export type SearchWebsitesInput = z.infer<typeof searchWebsitesInputSchema>;

export const searchFilesInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  sessionId: idSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export type SearchFilesInput = z.infer<typeof searchFilesInputSchema>;

export const getFileVersionsInputSchema = z.strictObject({
  fileId: idSchema,
  limit: z.number().int().min(1).max(20).default(10),
});
export type GetFileVersionsInput = z.infer<typeof getFileVersionsInputSchema>;

// ---------------------------------------------------------------------------
// Narrow output shapes — no raw DB rows, blob paths, or content hashes
// ---------------------------------------------------------------------------

export const narrowSearchResultSchema = z.strictObject({
  title: z.string().max(500),
  excerpt: z.string().max(500),
  occurredAt: z.string(),
  evidence: z.enum(["recorded", "verified-path", "title-only"]),
  sourceKind: z.enum([
    "activity",
    "browser-visit",
    "file-version",
    "checkpoint",
  ]),
});
export type NarrowSearchResult = z.infer<typeof narrowSearchResultSchema>;

export const narrowFileVersionSchema = z.strictObject({
  id: idSchema,
  fileId: idSchema,
  capturedAt: z.string(),
  mediaType: z.string(),
  byteLength: z.number(),
});
export type NarrowFileVersion = z.infer<typeof narrowFileVersionSchema>;

// ---------------------------------------------------------------------------
// Tool context — read-only repository access only
// ---------------------------------------------------------------------------

export interface AssistantToolContext {
  readonly repositories: Repositories;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function narrowSearchResult(r: SearchResult): NarrowSearchResult {
  return {
    title: r.title.slice(0, 500),
    excerpt: r.excerpt.slice(0, 500),
    occurredAt: r.occurredAt,
    evidence: r.evidence,
    sourceKind: r.source.kind,
  };
}

function narrowFileVersion(v: FileVersion): NarrowFileVersion {
  return {
    id: v.id,
    fileId: v.fileId,
    capturedAt: v.capturedAt,
    mediaType: v.mediaType,
    byteLength: v.byteLength,
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function toolSearchActivity(
  ctx: AssistantToolContext,
  rawInput: unknown,
): Promise<Result<NarrowSearchResult[]>> {
  const parsed = searchActivityInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return failure(
      "INVALID_INPUT",
      `Invalid search_activity input: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  const input = parsed.data;
  const result = await ctx.repositories.search.search({
    text: input.text,
    mode: "keyword",
    limit: input.limit,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  });
  if (!result.ok) return result;
  const filtered = result.value.filter(
    (r) => r.source.kind === "activity" || r.source.kind === "browser-visit",
  );
  return { ok: true, value: filtered.map(narrowSearchResult) };
}

export async function toolSearchWebsites(
  ctx: AssistantToolContext,
  rawInput: unknown,
): Promise<Result<NarrowSearchResult[]>> {
  const parsed = searchWebsitesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return failure(
      "INVALID_INPUT",
      `Invalid search_websites input: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  const input = parsed.data;
  const result = await ctx.repositories.search.search({
    text: input.text,
    mode: "keyword",
    limit: input.limit,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  });
  if (!result.ok) return result;
  const filtered = result.value.filter(
    (r) => r.source.kind === "browser-visit",
  );
  return { ok: true, value: filtered.map(narrowSearchResult) };
}

export async function toolSearchFiles(
  ctx: AssistantToolContext,
  rawInput: unknown,
): Promise<Result<NarrowSearchResult[]>> {
  const parsed = searchFilesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return failure(
      "INVALID_INPUT",
      `Invalid search_files input: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  const input = parsed.data;
  const result = await ctx.repositories.search.search({
    text: input.text,
    mode: "keyword",
    limit: input.limit,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  });
  if (!result.ok) return result;
  const filtered = result.value.filter((r) => r.source.kind === "file-version");
  return { ok: true, value: filtered.map(narrowSearchResult) };
}

export async function toolGetFileVersions(
  ctx: AssistantToolContext,
  rawInput: unknown,
): Promise<Result<NarrowFileVersion[]>> {
  const parsed = getFileVersionsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return failure(
      "INVALID_INPUT",
      `Invalid get_file_versions input: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  const { fileId, limit } = parsed.data;
  const result = await ctx.repositories.files.listVersions(fileId as Id);
  if (!result.ok) return result;
  const sliced = result.value.slice(0, limit);
  return { ok: true, value: sliced.map(narrowFileVersion) };
}
