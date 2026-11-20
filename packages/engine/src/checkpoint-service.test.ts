import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  failure,
  type ActivityEvent,
  type Checkpoint,
  type CheckpointCreate,
  type Result,
  type CapturedVersionSummary,
} from "@rewind/contracts";
import { CheckpointService } from "./checkpoint-service";

function fixture() {
  const at = "2026-11-17T10:00:00.000Z",
    sessionId = randomUUID(),
    checkpoints = new Map<string, Checkpoint>();
  const file: CapturedVersionSummary = {
    displayName: "Synthetic captured.txt",
    sourceLabel: "C:\\Synthetic\\captured.txt",
    version: {
      id: randomUUID(),
      fileId: randomUUID(),
      sessionId,
      capturedAt: at,
      contentHash: "a".repeat(64),
      byteLength: 11,
      mediaType: "text/plain",
    },
  };
  const activity: ActivityEvent = {
    id: randomUUID(),
    sessionId,
    occurredAt: at,
    source: "windows",
    type: "foreground",
    payload: {
      application: "Synthetic.exe",
      windowTitle: "Actual synthetic evidence",
    },
  };
  const readVersion = vi.fn(
    async (): Promise<Result<CapturedVersionSummary>> => ({
      ok: true,
      value: structuredClone(file),
    }),
  );
  const readActivity = vi.fn(
    async (id: string): Promise<Result<ActivityEvent | null>> => ({
      ok: true,
      value: id === activity.id ? structuredClone(activity) : null,
    }),
  );
  const save = vi.fn(async (checkpoint: Checkpoint): Promise<Result<void>> => {
    checkpoints.set(checkpoint.id, structuredClone(checkpoint));
    return { ok: true, value: undefined };
  });
  const admit = vi.fn(async (): Promise<Result<void>> => ({
    ok: true,
    value: undefined,
  }));
  const service = new CheckpointService({
    newId: randomUUID,
    now: () => "2026-11-17T10:01:00.000Z",
    sessions: {
      get: async () => ({
        ok: true,
        value: {
          id: sessionId,
          status: "ended",
          startedAt: at,
          updatedAt: at,
          endedAt: at,
        },
      }),
    },
    checkpoints: {
      save,
      get: async (id) => ({
        ok: true,
        value: checkpoints.has(id)
          ? structuredClone(checkpoints.get(id)!)
          : null,
      }),
    },
    readVersion,
    readActivity,
    admit,
  });
  const input: CheckpointCreate = {
    sessionId,
    name: "Synthetic named checkpoint",
    kept: true,
    fileVersionIds: [file.version.id],
    activityIds: [activity.id],
  };
  return {
    service,
    input,
    file,
    activity,
    checkpoints,
    readVersion,
    readActivity,
    save,
    admit,
  };
}
it("publishes an actual same-session evidence manifest and updates only name/Keep", async () => {
  const f = fixture(),
    created = await f.service.create(f.input);
  if (!created.ok) throw new Error("Synthetic checkpoint failed");
  expect(created.value).toMatchObject({
    ...f.input,
    browserVisitIds: [],
    projectReferences: [],
  });
  const viewed = await f.service.view(created.value.id);
  expect(viewed).toMatchObject({
    ok: true,
    value: {
      checkpoint: created.value,
      versions: [f.file],
      activities: [f.activity],
    },
  });
  expect(
    await f.service.update({
      id: created.value.id,
      name: "Renamed",
      kept: false,
    }),
  ).toMatchObject({
    ok: true,
    value: { ...created.value, name: "Renamed", kept: false },
  });
  expect(f.checkpoints.get(created.value.id)?.activityIds).toEqual(
    f.input.activityIds,
  );
  expect(f.checkpoints.get(created.value.id)?.fileVersionIds).toEqual(
    f.input.fileVersionIds,
  );
});
it("rejects empty, duplicate, cross-session and future evidence before publication", async () => {
  const f = fixture();
  for (const input of [
    { ...f.input, fileVersionIds: [], activityIds: [] },
    { ...f.input, activityIds: [f.activity.id, f.activity.id] },
  ])
    expect((await f.service.create(input)).ok).toBe(false);
  f.file.version.sessionId = randomUUID();
  expect(await f.service.create(f.input)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  f.file.version.sessionId = f.input.sessionId;
  f.activity.occurredAt = "2026-11-17T10:02:00.000Z";
  expect((await f.service.create(f.input)).ok).toBe(false);
  expect(f.save).not.toHaveBeenCalled();
});
it("does not substitute metadata-only, missing, corrupt or mismatched source records", async () => {
  const f = fixture();
  f.readVersion.mockResolvedValueOnce(
    failure("NOT_FOUND", "Synthetic uncaptured source"),
  );
  expect((await f.service.create(f.input)).ok).toBe(false);
  f.readVersion.mockResolvedValueOnce(
    failure("INTEGRITY_FAILURE", "Synthetic corrupt source"),
  );
  expect((await f.service.create(f.input)).ok).toBe(false);
  f.readActivity.mockResolvedValueOnce({ ok: true, value: null });
  expect((await f.service.create(f.input)).ok).toBe(false);
  f.file.version.id = randomUUID();
  expect((await f.service.create(f.input)).ok).toBe(false);
  expect(f.save).not.toHaveBeenCalled();
});
it("includes actual browser event IDs and rejects inconsistent stored membership", async () => {
  const f = fixture(),
    browser: ActivityEvent = {
      id: f.activity.id,
      sessionId: f.input.sessionId,
      occurredAt: f.activity.occurredAt,
      source: "browser",
      type: "browser-visit",
      payload: {
        id: f.activity.id,
        sessionId: f.input.sessionId,
        browser: "chrome",
        url: "https://example.test/",
        title: "Synthetic website",
        visitedAt: f.activity.occurredAt,
        endedAt: null,
        articleText:
          "Separately gated article bytes must not enter a checkpoint view",
      },
    };
  f.readActivity.mockResolvedValue({ ok: true, value: browser });
  const created = await f.service.create(f.input);
  if (!created.ok) throw new Error("Synthetic checkpoint failed");
  expect(created.value.browserVisitIds).toEqual([browser.id]);
  const viewed = await f.service.view(created.value.id);
  if (!viewed.ok || viewed.value.activities[0]?.type !== "browser-visit")
    throw new Error("Synthetic visit view missing");
  expect(viewed.value.activities[0].payload.articleText).toBeUndefined();
  f.checkpoints.get(created.value.id)!.browserVisitIds = [randomUUID()];
  expect(await f.service.view(created.value.id)).toMatchObject({
    ok: false,
    error: { code: "INTEGRITY_FAILURE" },
  });
});
it("does not publish through admission/save failures and bounds original-byte verification", async () => {
  const f = fixture();
  f.admit.mockResolvedValueOnce(failure("STORAGE_LIMIT", "Synthetic quota"));
  expect((await f.service.create(f.input)).ok).toBe(false);
  expect(f.save).not.toHaveBeenCalled();
  f.save.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic storage failure"),
  );
  expect((await f.service.create(f.input)).ok).toBe(false);
  expect(f.checkpoints.size).toBe(0);
  const ids = Array.from({ length: 5 }, () => randomUUID());
  for (const id of ids)
    f.readVersion.mockResolvedValueOnce({
      ok: true,
      value: {
        ...f.file,
        version: { ...f.file.version, id, byteLength: 16 * 1024 ** 2 },
      },
    });
  expect(
    await f.service.create({ ...f.input, fileVersionIds: ids }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(f.save).toHaveBeenCalledTimes(1);
});
it("fails views on lost evidence and permits Unkeep so a broken retained manifest can be released", async () => {
  const f = fixture(),
    created = await f.service.create(f.input);
  if (!created.ok) throw new Error("Synthetic checkpoint failed");
  f.readVersion.mockResolvedValue(
    failure("INTEGRITY_FAILURE", "Synthetic corrupt bytes"),
  );
  expect((await f.service.view(created.value.id)).ok).toBe(false);
  expect(
    (
      await f.service.update({
        id: created.value.id,
        name: created.value.name,
        kept: true,
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.service.update({
        id: created.value.id,
        name: created.value.name,
        kept: false,
      })
    ).ok,
  ).toBe(true);
});
it("rejects oversized escaped evidence metadata before publishing a manifest", async () => {
  const f = fixture(),
    ids = Array.from({ length: 200 }, () => randomUUID());
  f.readActivity.mockImplementation(async (id) => ({
    ok: true,
    value: {
      ...f.activity,
      id,
      type: "foreground",
      source: "windows",
      payload: { application: "Synthetic.exe", windowTitle: "\0".repeat(2048) },
    },
  }));
  expect(
    await f.service.create({
      ...f.input,
      fileVersionIds: [],
      activityIds: ids,
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(f.save).not.toHaveBeenCalled();
});
