import { expect, it } from "vitest";
import { createDefaultSettings, type ActivityEvent } from "@rewind/contracts";
import { isExcluded } from "./event-exclusions";
const base = {
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  occurredAt: "2026-11-16T10:00:00.000Z",
};
it("uses path components rather than matching excluded-folder siblings", () => {
  const settings = {
    ...createDefaultSettings(),
    excludedFolderPaths: ["C:\\private"],
  };
  const opened = (path: string): ActivityEvent => ({
    ...base,
    source: "rewind",
    type: "file-opened",
    payload: {
      id: base.id,
      displayName: "Synthetic",
      identity: {
        kind: "verified-path",
        absolutePath: path,
        verifiedAt: base.occurredAt,
      },
    },
  });
  expect(isExcluded(opened("C:\\PRIVATE\\report.txt"), settings)).toBe(true);
  expect(isExcluded(opened("C:\\private-sibling\\report.txt"), settings)).toBe(
    false,
  );
  expect(
    isExcluded(opened("C:\\public\\..\\private\\report.txt"), settings),
  ).toBe(true);
});
it("matches excluded hosts and subdomains while preserving sibling hosts", () => {
  const settings = {
    ...createDefaultSettings(),
    excludedSiteHosts: ["example.com"],
  };
  const visit = (host: string): ActivityEvent => ({
    ...base,
    source: "browser",
    type: "browser-visit",
    payload: {
      id: base.id,
      sessionId: base.sessionId,
      browser: "chrome",
      title: "Synthetic",
      url: `https://${host}/`,
      visitedAt: base.occurredAt,
      endedAt: null,
    },
  });
  expect(isExcluded(visit("sub.example.com"), settings)).toBe(true);
  expect(isExcluded(visit("example.com."), settings)).toBe(true);
  expect(isExcluded(visit("otherexample.com"), settings)).toBe(false);
});
