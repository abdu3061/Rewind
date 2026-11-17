import { expect, it, vi } from "vitest";
import {
  boundedWorkerMessage,
  recordingCommandSchema,
  workerOutputSchema,
  timelineResponseSchema,
} from "@rewind/contracts";
import { dispatchRecordingRequest } from "./recording-ipc";
import type { WorkerClient } from "./worker-client";

it("rejects private worker messages and privilege expansion before calling the backend", async () => {
  const request = vi.fn();
  const backend = { request } as unknown as WorkerClient;
  for (const command of [
    { kind: "shutdown" },
    { kind: "init", key: new Uint8Array(32) },
    {
      kind: "privacy.update",
      value: {
        collectionConsent: true,
        excludedApplications: [],
        cloudAiEnabled: true,
      },
    },
    { kind: "timeline.query", query: { limit: 101 } },
    { kind: "timeline.query", query: { limit: 10, types: ["idle"] } },
    { kind: "history.list", query: { limit: 10, path: "C:\\synthetic" } },
  ])
    expect(await dispatchRecordingRequest(backend, command)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  expect(request).not.toHaveBeenCalled();
  expect(
    recordingCommandSchema.safeParse({
      kind: "privacy.update",
      value: {
        collectionConsent: true,
        excludedApplications: Array.from({ length: 201 }, () => "example.exe"),
      },
    }).success,
  ).toBe(false);
});

it.each(["foreground", "browser-visit"] as const)(
  "fits a maximum %s metadata page without dropping the worker and rejects oversized messages",
  (type) => {
    const id = "00000000-0000-4000-8000-000000000001";
    const response = {
      version: 1,
      type: "reply",
      bootId: id,
      id,
      kind: "timeline",
      result: {
        ok: true,
        value: Array.from({ length: 100 }, () => ({
          id,
          sessionId: id,
          occurredAt: "2026-11-17T10:00:00.000Z",
          type,
          source: type === "foreground" ? "windows" : "browser",
          payload:
            type === "foreground"
              ? {
                  application: "x".repeat(255),
                  windowTitle: "\u0000".repeat(2048),
                }
              : {
                  id,
                  sessionId: id,
                  browser: "chrome",
                  url:
                    "https://example.test/" +
                    "x".repeat(8192 - "https://example.test/".length),
                  title: "\u0000".repeat(2048),
                  visitedAt: "2026-11-17T10:00:00.000Z",
                  endedAt: null,
                },
        })),
      },
    };
    expect(workerOutputSchema.safeParse(response).success).toBe(true);
    expect(timelineResponseSchema.safeParse(response.result).success).toBe(
      true,
    );
    expect(boundedWorkerMessage(response)).toBe(true);
    expect(boundedWorkerMessage({ data: "x".repeat(2 * 1024 * 1024) })).toBe(
      false,
    );
  },
);

it("routes read-only browser history filters without granting recording or article permission", async () => {
  const request = vi.fn(async () => ({ ok: true, value: [] }));
  const backend = { request } as unknown as WorkerClient;
  const query = { limit: 10, types: ["browser-visit"] };
  expect(
    await dispatchRecordingRequest(backend, { kind: "timeline.query", query }),
  ).toEqual({ ok: true, value: [] });
  expect(request).toHaveBeenCalledWith(
    { kind: "timeline", query },
    timelineResponseSchema,
  );
});

it("rejects article text or unredacted URLs in browser timeline responses", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const payload = {
    id,
    sessionId: id,
    browser: "chrome",
    title: "Synthetic",
    url: "https://example.test/page",
    visitedAt: "2026-11-17T10:00:00.000Z",
    endedAt: null,
  };
  for (const change of [
    { articleText: "Synthetic separate permission" },
    { url: "https://example.test/page?token=synthetic#fragment" },
  ]) {
    expect(
      timelineResponseSchema.safeParse({
        ok: true,
        value: [
          {
            id,
            sessionId: id,
            type: "browser-visit",
            source: "browser",
            occurredAt: payload.visitedAt,
            payload: { ...payload, ...change },
          },
        ],
      }).success,
    ).toBe(false);
  }
});
