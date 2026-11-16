import { expect, it, vi } from "vitest";
import {
  boundedWorkerMessage,
  recordingCommandSchema,
  workerOutputSchema,
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
    { kind: "timeline.query", query: { limit: 10, types: ["browser-visit"] } },
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

it("fits the largest legal timeline page without dropping the worker and rejects oversized messages", () => {
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
        type: "foreground",
        source: "windows",
        payload: {
          application: "x".repeat(255),
          windowTitle: "\u0000".repeat(2048),
        },
      })),
    },
  };
  expect(workerOutputSchema.safeParse(response).success).toBe(true);
  expect(boundedWorkerMessage(response)).toBe(true);
  expect(boundedWorkerMessage({ data: "x".repeat(2 * 1024 * 1024) })).toBe(
    false,
  );
});
