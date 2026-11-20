import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  failure,
  type ActivityEvent,
  type AssistantEvidenceSource,
  type Result,
} from "@rewind/contracts";
import {
  AssistantReviewService,
  type AssistantReviewOptions,
} from "./assistant-review-service";

function fixture() {
  let now = "2026-11-18T10:00:00.000Z",
    ticks = 0,
    permitted = true;
  const settings = { ...createDefaultSettings(), cloudAiEnabled: true };
  const event: ActivityEvent = {
    id: randomUUID(),
    sessionId: randomUUID(),
    occurredAt: now,
    type: "foreground",
    source: "windows",
    payload: {
      application: "Synthetic.exe",
      windowTitle: "Synthetic title <untrusted>",
    },
  };
  const sources = new Map<string, AssistantEvidenceSource>([
    [event.id, { event, kept: false, retentionAnchor: now }],
  ]);
  const read = vi.fn(
    async (id: string): Promise<Result<AssistantEvidenceSource | null>> => ({
      ok: true,
      value: structuredClone(sources.get(id) ?? null),
    }),
  );
  const disclosable = vi.fn<AssistantReviewOptions["disclosable"]>(() => ({
    ok: true,
    value: undefined,
  }));
  const service = new AssistantReviewService({
    newId: randomUUID,
    now: () => now,
    monotonicNow: () => ticks,
    permitted: () => permitted,
    settings: () => settings,
    read,
    disclosable,
  });
  return {
    service,
    event,
    sources,
    settings,
    read,
    disclosable,
    setWall: (value: string) => {
      now = value;
    },
    setTicks: (value: number) => {
      ticks = value;
    },
    deny: () => {
      permitted = false;
      service.invalidate();
    },
    async prepare(ids = [event.id]) {
      const result = await service.prepare({
        question: "Which title was recorded?",
        activityIds: ids,
      });
      if (!result.ok) throw new Error("SYNTHETIC_EVIDENCE_REVIEW_FAILED");
      return result.value;
    },
  };
}
it("builds an immutable local review from actual source IDs and discloses only the explicitly selected subset", async () => {
  const f = fixture(),
    second = { ...structuredClone(f.event), id: randomUUID() };
  f.sources.set(second.id, {
    event: second,
    kept: false,
    retentionAnchor: second.occurredAt,
  });
  const review = await f.prepare([f.event.id, second.id]);
  expect(review.evidence[0]).toMatchObject({
    key: "E1",
    source: { kind: "activity", activityId: f.event.id },
    evidence: "title-only",
  });
  review.question = "Tampered question";
  review.evidence[1]!.title = "Tampered record";
  const claimed = await f.service.claim({
    id: review.id,
    keys: ["E2"],
    confirmed: true,
  });
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) return;
  expect(claimed.value.request).toMatchObject({
    question: "Which title was recorded?",
    evidence: [
      {
        key: "E2",
        source: { activityId: second.id },
        title: "Synthetic title <untrusted>",
      },
    ],
  });
  expect(claimed.value.current()).toBe(true);
  expect((await claimed.value.verify(claimed.value.request.evidence)).ok).toBe(
    true,
  );
  const changed = structuredClone(claimed.value.request.evidence);
  changed[0]!.excerpt = "Unapproved text";
  expect((await claimed.value.verify(changed)).ok).toBe(false);
  expect((await claimed.value.verify([])).ok).toBe(false);
  expect(
    (await f.service.claim({ id: review.id, keys: ["E2"], confirmed: true }))
      .ok,
  ).toBe(false);
  claimed.value.finish();
  expect(claimed.value.current()).toBe(false);
});
it("requires cloud permission and explicit bounded review approval", async () => {
  const f = fixture();
  f.settings.cloudAiEnabled = false;
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [f.event.id],
      })
    ).ok,
  ).toBe(false);
  expect(f.read).not.toHaveBeenCalled();
  f.settings.cloudAiEnabled = true;
  const review = await f.prepare();
  expect(
    (
      await f.service.claim({
        id: review.id,
        keys: ["E1"],
        confirmed: false as true,
      })
    ).ok,
  ).toBe(false);
  expect(
    (await f.service.claim({ id: review.id, keys: ["E12"], confirmed: true }))
      .ok,
  ).toBe(false);
  expect(
    (await f.service.prepare({ question: " ", activityIds: [f.event.id] })).ok,
  ).toBe(false);
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [f.event.id, f.event.id],
      })
    ).ok,
  ).toBe(false);
});
it("redacts browser queries/fragments and omits separately gated article content", async () => {
  const f = fixture(),
    browser: ActivityEvent = {
      id: randomUUID(),
      sessionId: f.event.sessionId,
      occurredAt: f.event.occurredAt,
      type: "browser-visit",
      source: "browser",
      payload: {
        id: randomUUID(),
        sessionId: f.event.sessionId,
        browser: "chrome",
        url: "https://example.test/project?private=Marker#fragment",
        title: "Recorded page",
        visitedAt: f.event.occurredAt,
        endedAt: null,
        articleText: "SeparateArticleSecretMarker",
      },
    };
  f.sources.set(browser.id, {
    event: browser,
    kept: false,
    retentionAnchor: browser.occurredAt,
  });
  const review = await f.prepare([browser.id]);
  expect(JSON.stringify(review)).toContain("https://example.test/project");
  for (const text of [
    "private=Marker",
    "#fragment",
    "SeparateArticleSecretMarker",
  ])
    expect(JSON.stringify(review)).not.toContain(text);
  expect(review.evidence[0]!.source).toEqual({
    kind: "activity",
    activityId: browser.id,
  });
  f.settings.excludedSiteHosts = ["example.test"];
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [browser.id],
      })
    ).ok,
  ).toBe(false);
});
it("checks current application/site/folder exclusions and never turns stored paths into file access", async () => {
  const f = fixture();
  f.settings.excludedApplications = ["synthetic.exe"];
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [f.event.id],
      })
    ).ok,
  ).toBe(false);
  f.settings.excludedApplications = [];
  f.settings.excludedSiteHosts = ["invalid host"];
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [f.event.id],
      })
    ).ok,
  ).toBe(false);
  f.settings.excludedSiteHosts = [];
  const fileId = randomUUID(),
    fileEvent: ActivityEvent = {
      id: randomUUID(),
      sessionId: f.event.sessionId,
      occurredAt: f.event.occurredAt,
      type: "file-change",
      source: "filesystem",
      payload: { fileId, displayName: "synthetic.txt", change: "captured" },
    };
  f.sources.set(fileEvent.id, {
    event: fileEvent,
    kept: false,
    retentionAnchor: fileEvent.occurredAt,
    file: {
      id: fileId,
      displayName: "synthetic.txt",
      identity: {
        kind: "verified-path",
        absolutePath: "C:\\Synthetic\\private\\synthetic.txt",
        verifiedAt: fileEvent.occurredAt,
      },
    },
  });
  const review = await f.prepare([fileEvent.id]);
  expect(JSON.stringify(review)).not.toContain("C:\\Synthetic");
  f.settings.excludedFolderPaths = ["C:\\Synthetic\\private"];
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [fileEvent.id],
      })
    ).ok,
  ).toBe(false);
});
it("denies disclosure of sensitive records and does not allow the denial port to mutate approved text", async () => {
  const f = fixture();
  f.disclosable.mockImplementationOnce(() =>
    failure("FORBIDDEN", "Synthetic private credential in selected data"),
  );
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [f.event.id],
      })
    ).ok,
  ).toBe(false);
  f.disclosable.mockImplementationOnce((record) => {
    record.title = "Changed by verifier";
    return { ok: true, value: undefined };
  });
  const review = await f.prepare();
  expect(review.evidence[0]!.title).toBe("Synthetic title <untrusted>");
});
it("allows actual kept or linked checkpoint evidence while refusing expired unprotected records", async () => {
  const f = fixture();
  f.settings.retentionHours = 1;
  const source = f.sources.get(f.event.id)!;
  source.event.occurredAt = "2026-11-16T10:00:00.000Z";
  source.retentionAnchor = source.event.occurredAt;
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [f.event.id],
      })
    ).ok,
  ).toBe(false);
  source.kept = true;
  expect((await f.prepare()).evidence).toHaveLength(1);
  source.kept = false;
  source.retentionAnchor = "2026-11-18T09:30:00.000Z";
  expect((await f.prepare()).evidence).toHaveLength(1);
});
it("expires near-boundary authority on monotonic time even if the wall clock moves backward", async () => {
  const f = fixture();
  f.settings.retentionHours = 1;
  const source = f.sources.get(f.event.id)!;
  source.event.occurredAt = "2026-11-18T09:00:00.500Z";
  source.retentionAnchor = source.event.occurredAt;
  const review = await f.prepare();
  expect(review.expiresAt).toBe("2026-11-18T10:00:00.501Z");
  f.setWall("2026-11-18T09:30:00.000Z");
  f.setTicks(1000);
  expect(
    (await f.service.claim({ id: review.id, keys: ["E1"], confirmed: true }))
      .ok,
  ).toBe(false);
});
it("invalidates reviewed and in-flight leases on policy changes, source deletion, changed source or service closure", async () => {
  const f = fixture(),
    review = await f.prepare(),
    lease = await f.service.claim({
      id: review.id,
      keys: ["E1"],
      confirmed: true,
    });
  if (!lease.ok) throw new Error("SYNTHETIC_LEASE_FAILED");
  f.settings.excludedApplications = ["other.exe"];
  expect(lease.value.current()).toBe(false);
  f.settings.excludedApplications = [];
  expect(lease.value.current()).toBe(false);
  f.sources.delete(f.event.id);
  expect((await lease.value.verify(lease.value.request.evidence)).ok).toBe(
    false,
  );
  f.service.invalidate();
  expect(lease.value.current()).toBe(false);
  f.service.close();
  expect(
    (
      await f.service.prepare({
        question: "Question",
        activityIds: [f.event.id],
      })
    ).ok,
  ).toBe(false);
});
it("rejects changed retained text and never revives a failed disclosure lease after the text is restored", async () => {
  const f = fixture(),
    review = await f.prepare();
  const result = await f.service.claim({
    id: review.id,
    keys: ["E1"],
    confirmed: true,
  });
  if (!result.ok) throw new Error("SYNTHETIC_LEASE_FAILED");
  const source = f.sources.get(f.event.id)!;
  if (source.event.type !== "foreground")
    throw new Error("SYNTHETIC_EVENT_TYPE");
  source.event.payload.windowTitle = "Changed retained observation";
  expect((await result.value.verify(result.value.request.evidence)).ok).toBe(
    false,
  );
  source.event.payload.windowTitle = f.event.payload.windowTitle;
  expect(result.value.current()).toBe(false);
  expect((await result.value.verify(result.value.request.evidence)).ok).toBe(
    false,
  );
});
it("shortens a kept source lease when checkpoint protection is removed, even if the wall clock then moves backward", async () => {
  const f = fixture();
  f.settings.retentionHours = 1;
  const source = f.sources.get(f.event.id)!;
  source.kept = true;
  source.event.occurredAt = "2026-11-18T09:00:00.500Z";
  source.retentionAnchor = source.event.occurredAt;
  const review = await f.prepare();
  expect(review.expiresAt).toBe("2026-11-18T10:05:00.000Z");
  const result = await f.service.claim({
    id: review.id,
    keys: ["E1"],
    confirmed: true,
  });
  if (!result.ok) throw new Error("SYNTHETIC_LEASE_FAILED");
  source.kept = false;
  expect((await result.value.verify(result.value.request.evidence)).ok).toBe(
    true,
  );
  f.setWall("2026-11-18T09:30:00.000Z");
  f.setTicks(501);
  expect(result.value.current()).toBe(false);
});
it("fences a delayed local source query after permission denial", async () => {
  const f = fixture();
  let finish: (
    value: Result<AssistantEvidenceSource | null>,
  ) => void = () => {};
  f.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const preparing = f.service.prepare({
    question: "Question",
    activityIds: [f.event.id],
  });
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
  f.deny();
  finish({ ok: true, value: f.sources.get(f.event.id)! });
  expect((await preparing).ok).toBe(false);
  expect(f.read).toHaveBeenCalledTimes(1);
});
