import { expect, it } from "vitest";
import {
  recordingCommandSchema,
  workerCommandSchema,
  fileTextSearchReceiptSchema,
} from "./index";

const id = "00000000-0000-4000-8000-000000000001",
  stamp = "2026-11-19T12:00:00.000Z";
it("public and worker content capabilities reject body writes, path/credential injection and unconfirmed indexing", () => {
  for (const schema of [recordingCommandSchema, workerCommandSchema]) {
    expect(
      schema.safeParse({
        kind: "content.index",
        value: { confirmed: true, retryFailures: false },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        kind: "content.search",
        query: { text: "synthetic", limit: 25 },
      }).success,
    ).toBe(true);
    for (const command of [
      { kind: "content.publish", versionId: id, text: "injected" },
      {
        kind: "content.index",
        value: { confirmed: false, retryFailures: false },
      },
      {
        kind: "content.index",
        value: {
          confirmed: true,
          retryFailures: false,
          mode: "automatic",
          sessionId: id,
        },
      },
      {
        kind: "content.search",
        query: {
          text: "synthetic",
          limit: 25,
          path: "C:\\Synthetic",
          key: "injected",
        },
      },
      { kind: "content.search", query: { text: "synthetic", limit: 26 } },
      { kind: "content.stop", owner: id },
    ])
      expect(schema.safeParse(command).success).toBe(false);
  }
});
it("requires a current source generation and a usable cursor exactly when a search page has more results", () => {
  const page = {
    authority: { generation: id, revision: 1 },
    hits: [],
    hasMore: false,
  };
  expect(fileTextSearchReceiptSchema.safeParse(page).success).toBe(true);
  expect(
    fileTextSearchReceiptSchema.safeParse({ ...page, hasMore: true }).success,
  ).toBe(false);
  expect(
    fileTextSearchReceiptSchema.safeParse({
      ...page,
      hasMore: true,
      nextBefore: { capturedAt: stamp, id },
    }).success,
  ).toBe(true);
  expect(
    fileTextSearchReceiptSchema.safeParse({
      ...page,
      authority: { generation: "invalid", revision: 1 },
    }).success,
  ).toBe(false);
});
