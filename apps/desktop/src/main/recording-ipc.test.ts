import { expect, it, vi } from "vitest";
import {
  boundedWorkerMessage,
  recordingCommandSchema,
  workerOutputSchema,
  timelineResponseSchema,
  browserControlResponseSchema,
  acknowledgementResponseSchema,
  recoveryOverwriteProposalResponseSchema,
  recoveryOverwriteResultResponseSchema,
} from "@rewind/contracts";
import { dispatchRecordingRequest } from "./recording-ipc";
import type { WorkerClient } from "./worker-client";
it("keeps document binaries and recovery source metadata private while validating preview/cancel request IDs", async () => {
  const id = "00000000-0000-4000-8000-000000000001",
    request = vi.fn(),
    backend = { request } as unknown as WorkerClient;
  for (const command of [
    { kind: "versions.source", id },
    { type: "document-parse", id, format: "pdf", bytes: Uint8Array.of(1) },
    { kind: "versions.preview", id, requestId: "invalid" },
    { kind: "versions.cancel-preview", requestId: id, path: "C:\\synthetic" },
  ])
    expect(await dispatchRecordingRequest(backend, command)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  expect(request).not.toHaveBeenCalled();
});
it("prepares overwrite only from the native dialog and rejects renderer paths or missing confirmation", async () => {
  const id = "00000000-0000-4000-8000-000000000001",
    request = vi.fn().mockResolvedValue({ ok: true, value: null }),
    choose = vi.fn().mockResolvedValue("C:\\Synthetic\\selected.txt"),
    backend = { request } as unknown as WorkerClient;
  request.mockResolvedValueOnce({
    ok: true,
    value: { displayName: "Synthetic source.txt" },
  });
  await dispatchRecordingRequest(
    backend,
    { kind: "recovery.choose-overwrite", versionId: id },
    undefined,
    undefined,
    undefined,
    choose,
  );
  expect(choose).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenLastCalledWith(
    {
      kind: "recovery.prepare-overwrite",
      versionId: id,
      path: "C:\\Synthetic\\selected.txt",
    },
    recoveryOverwriteProposalResponseSchema,
  );
  await dispatchRecordingRequest(backend, {
    kind: "recovery.confirm-overwrite",
    proposalId: id,
    confirmed: true,
  });
  expect(request).toHaveBeenLastCalledWith(
    { kind: "recovery.confirm-overwrite", proposalId: id, confirmed: true },
    recoveryOverwriteResultResponseSchema,
  );
  const calls = request.mock.calls.length;
  for (const input of [
    { kind: "recovery.prepare-overwrite", versionId: id, path: "C:\\Expanded" },
    { kind: "recovery.choose-overwrite", versionId: id, path: "C:\\Expanded" },
    { kind: "recovery.confirm-overwrite", proposalId: id, confirmed: false },
  ])
    expect((await dispatchRecordingRequest(backend, input)).ok).toBe(false);
  expect(request).toHaveBeenCalledTimes(calls);
  choose.mockResolvedValueOnce(null);
  request.mockResolvedValueOnce({
    ok: true,
    value: { displayName: "Synthetic source.txt" },
  });
  expect(
    await dispatchRecordingRequest(
      backend,
      { kind: "recovery.choose-overwrite", versionId: id },
      undefined,
      undefined,
      undefined,
      choose,
    ),
  ).toEqual({ ok: true, value: null });
  expect(request).toHaveBeenCalledTimes(calls + 1);
});
it("forwards only validated browser capabilities and verifies assets before opening the fixed extension folder", async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, value: true }),
    open = vi.fn().mockResolvedValue({ ok: true, value: true }),
    backend = { request } as unknown as WorkerClient;
  expect(
    (
      await dispatchRecordingRequest(backend, {
        kind: "browser.permission",
        enabled: false,
      })
    ).ok,
  ).toBe(true);
  expect(request).toHaveBeenLastCalledWith(
    { kind: "browser.permission", enabled: false },
    browserControlResponseSchema,
  );
  expect(
    (
      await dispatchRecordingRequest(backend, {
        kind: "browser.exclusions",
        hosts: ["Example.COM.", "example.com"],
      })
    ).ok,
  ).toBe(true);
  expect(request).toHaveBeenLastCalledWith(
    { kind: "browser.exclusions", hosts: ["example.com"] },
    browserControlResponseSchema,
  );
  expect(
    (
      await dispatchRecordingRequest(
        backend,
        { kind: "browser.open-extension" },
        undefined,
        undefined,
        open,
      )
    ).ok,
  ).toBe(true);
  expect(request).toHaveBeenLastCalledWith(
    { kind: "browser.verify-assets" },
    acknowledgementResponseSchema,
  );
  expect(open).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce({
    ok: false,
    error: { code: "INTEGRITY_FAILURE", message: "Synthetic asset mismatch." },
  });
  expect(
    (
      await dispatchRecordingRequest(
        backend,
        { kind: "browser.open-extension" },
        undefined,
        undefined,
        open,
      )
    ).ok,
  ).toBe(false);
  expect(open).toHaveBeenCalledTimes(1);
  const calls = request.mock.calls.length;
  for (const input of [
    { kind: "browser.install", browsers: ["chrome"], confirmed: false },
    {
      kind: "browser.install",
      browsers: ["chrome"],
      confirmed: true,
      path: "C:\\ExpandedFixture",
    },
    { kind: "browser.open-extension", path: "C:\\ExpandedFixture" },
    { kind: "browser.exclusions", hosts: ["https://private.example"] },
  ])
    expect((await dispatchRecordingRequest(backend, input)).ok).toBe(false);
  expect(request).toHaveBeenCalledTimes(calls);
});

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
