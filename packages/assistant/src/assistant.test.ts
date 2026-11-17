import { describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  type Repositories,
  type SearchResult,
} from "@rewind/contracts";
import { GeminiAssistantService } from "./gemini-service";
import {
  toolGetFileVersions,
  toolSearchActivity,
  toolSearchFiles,
  toolSearchWebsites,
} from "./tools";

const activityId = "4a20c4ec-a89f-4fd3-85f7-2e9bdd998a8a";
const versionId = "5899ac1f-8f73-45d1-9d58-66756fce5391";
const fileId = "cadccd01-2948-4d1f-8108-e792c87b69d0";

function searchResult(
  kind: "activity" | "browser-visit" | "file-version" | "checkpoint",
): SearchResult {
  const source: SearchResult["source"] =
    kind === "activity"
      ? { kind, activityId }
      : kind === "browser-visit"
        ? { kind, browserVisitId: activityId }
        : kind === "file-version"
          ? { kind, fileId, fileVersionId: versionId }
          : { kind, checkpointId: activityId };
  return {
    source,
    occurredAt: "2026-11-16T10:00:00.000Z",
    title: `${kind} title`,
    excerpt: `${kind} excerpt`,
    evidence: "recorded",
  };
}

function repositories(
  search: Repositories["search"]["search"],
  listVersions = vi.fn(),
) {
  return {
    search: { search },
    files: { listVersions },
  } as unknown as Repositories;
}

describe("assistant tools", () => {
  it("rejects malformed and out-of-bound tool inputs", async () => {
    const search = vi.fn();
    const ctx = { repositories: repositories(search) };

    const badQuery = await toolSearchActivity(ctx, { text: "   " });
    const oversizedLimit = await toolSearchWebsites(ctx, {
      text: "meeting",
      limit: 21,
    });
    const badFileId = await toolGetFileVersions(ctx, {
      fileId: "not-a-uuid",
      limit: 5,
    });

    expect(badQuery).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(oversizedLimit).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(badFileId).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("uses bounded read-only searches and filters each requested evidence kind", async () => {
    const search = vi.fn(async () => ({
      ok: true as const,
      value: [
        searchResult("activity"),
        searchResult("browser-visit"),
        searchResult("file-version"),
        searchResult("checkpoint"),
      ],
    }));
    const ctx = { repositories: repositories(search) };

    const activity = await toolSearchActivity(ctx, {
      text: "report",
      limit: 2,
    });
    const websites = await toolSearchWebsites(ctx, { text: "report" });
    const files = await toolSearchFiles(ctx, { text: "report" });

    expect(search).toHaveBeenCalledTimes(3);
    expect(search).toHaveBeenCalledWith({
      text: "report",
      mode: "keyword",
      limit: 2,
    });
    expect(
      activity.ok && activity.value.map((item) => item.sourceKind),
    ).toEqual(["activity", "browser-visit"]);
    expect(
      websites.ok && websites.value.map((item) => item.sourceKind),
    ).toEqual(["browser-visit"]);
    expect(files.ok && files.value.map((item) => item.sourceKind)).toEqual([
      "file-version",
    ]);
  });

  it("lists file version metadata through the read-only repository query", async () => {
    const version = {
      id: versionId,
      fileId,
      capturedAt: "2026-11-16T10:00:00.000Z",
      mediaType: "text/plain",
      byteLength: 42,
      contentHash: "internal-hash",
      blobPath: "/private/blob",
    };
    const listVersions = vi.fn(async () => ({
      ok: true as const,
      value: [version],
    }));
    const result = await toolGetFileVersions(
      { repositories: repositories(vi.fn(), listVersions) },
      { fileId, limit: 1 },
    );

    expect(listVersions).toHaveBeenCalledWith(fileId);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: versionId,
          fileId,
          capturedAt: version.capturedAt,
          mediaType: "text/plain",
          byteLength: 42,
        },
      ],
    });
  });

  it("rejects cloud assistant use before loading the provider SDK when disabled", async () => {
    const settings = { ...createDefaultSettings(), cloudAiEnabled: false };
    const service = new GeminiAssistantService({
      apiKey: "test-only-key",
      repositories: repositories(vi.fn()),
      settings,
    });

    await expect(service.ask("What was I working on?")).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });
});
