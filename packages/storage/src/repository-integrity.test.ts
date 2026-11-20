import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ActivityEvent, Session } from "@rewind/contracts";
import { SqliteActivityRepository } from "./activity-repository";
import { SqliteFileRepository } from "./file-repository";
import { SqliteSessionRepository } from "./session-repository";
import { SqliteSearchRepository } from "./search-repository";

let db: DatabaseSync;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = "2026-11-16T10:00:00.000Z";
const session: Session = {
  id: id(1),
  status: "active",
  startedAt: time,
  updatedAt: time,
  endedAt: null,
};
const event: ActivityEvent = {
  id: id(2),
  sessionId: id(1),
  occurredAt: time,
  type: "idle",
  source: "windows",
  payload: { state: "entered" },
};
beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      resolve(__dirname, "../../../db/migrations/001_initial.sql"),
      "utf8",
    ),
  );
  await new SqliteSessionRepository(db).save(session);
});
afterEach(() => {
  if (db.isOpen) db.close();
});

it("rejects invalid sessions instead of silently storing invalid chronology", async () => {
  expect(
    await new SqliteSessionRepository(db).save({
      ...session,
      id: id(10),
      updatedAt: "2020-01-01T00:00:00.000Z",
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
});
it("does not report success when an upsert changes immutable session identity", async () => {
  expect(
    await new SqliteSessionRepository(db).save({
      ...session,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
});
it("rejects corrupt hydrated session chronology", async () => {
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
    "synthetic-invalid-time",
    id(1),
  );
  expect(await new SqliteSessionRepository(db).getLatest()).toMatchObject({
    ok: false,
    error: { code: "INTEGRITY_FAILURE" },
  });
});
it("rejects a mixed invalid event batch atomically", async () => {
  const result = await new SqliteActivityRepository(db).append([
    event,
    {
      ...event,
      id: id(3),
      payload: { state: "invalid" },
    } as unknown as ActivityEvent,
  ]);
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM activities").get()?.count,
  ).toBe(0);
});
it("rejects writes to paused sessions at the repository transaction boundary", async () => {
  await new SqliteSessionRepository(db).save({ ...session, status: "paused" });
  expect(await new SqliteActivityRepository(db).append([event])).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});
it("rejects a browser payload linked to a different session", async () => {
  const visit: ActivityEvent = {
    ...event,
    source: "browser",
    type: "browser-visit",
    payload: {
      id: id(7),
      sessionId: id(8),
      browser: "chrome",
      title: "Synthetic",
      url: "https://example.com",
      visitedAt: time,
      endedAt: null,
    },
  };
  expect(await new SqliteActivityRepository(db).append([visit])).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});
it("does not hydrate malformed activity JSON or return its contents", async () => {
  db.prepare("INSERT INTO activities VALUES (?, ?, ?, ?, ?, ?)").run(
    id(2),
    id(1),
    "idle",
    "windows",
    time,
    "synthetic-private-content",
  );
  expect(await new SqliteActivityRepository(db).list(id(1), 10)).toEqual({
    ok: false,
    error: {
      code: "INTEGRITY_FAILURE",
      message: "Stored activity is invalid.",
    },
  });
});
it("saves file-opened references atomically with their activity", async () => {
  const opened: ActivityEvent = {
    ...event,
    type: "file-opened",
    source: "rewind",
    payload: {
      id: id(5),
      displayName: "Synthetic",
      identity: { kind: "unverified", observedTitle: "Synthetic" },
    },
  };
  const repo = new SqliteActivityRepository(db);
  expect((await repo.append([opened])).ok).toBe(true);
  expect(await new SqliteFileRepository(db).getReference(id(5))).toEqual({
    ok: true,
    value: opened.payload,
  });
  const duplicate = {
    ...opened,
    payload: { ...opened.payload, displayName: "Must roll back" },
  };
  expect((await repo.append([duplicate])).ok).toBe(false);
  expect(await new SqliteFileRepository(db).getReference(id(5))).toEqual({
    ok: true,
    value: opened.payload,
  });
});
it("rejects unknown file-change identities rather than inventing a reference", async () => {
  expect(
    await new SqliteActivityRepository(db).append([
      {
        ...event,
        type: "file-change",
        source: "filesystem",
        payload: { fileId: id(50), change: "updated" },
      },
    ]),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

it("omits uncaptured files instead of fabricating a version ID", async () => {
  await new SqliteFileRepository(db).saveReference({
    id: id(6),
    displayName: "Synthetic",
    identity: { kind: "unverified", observedTitle: "Synthetic" },
  });
  expect(
    await new SqliteSearchRepository(db).search({
      text: "Synthetic",
      mode: "keyword",
      limit: 10,
      sessionId: id(9),
    }),
  ).toEqual({ ok: true, value: [] });
});
it("selects the latest file version within the requested session and date scope", async () => {
  const files = new SqliteFileRepository(db);
  await files.saveReference({
    id: id(6),
    displayName: "Synthetic",
    identity: { kind: "unverified", observedTitle: "Synthetic" },
  });
  await new SqliteSessionRepository(db).save({ ...session, id: id(9) });
  for (const [versionId, sessionId, capturedAt] of [
    [id(10), id(1), time],
    [id(11), id(9), "2026-11-17T10:00:00.000Z"],
    [id(12), id(1), "2026-11-18T10:00:00.000Z"],
  ]) {
    await files.addVersion({
      id: versionId!,
      sessionId: sessionId!,
      capturedAt: capturedAt!,
      fileId: id(6),
      contentHash: "a".repeat(64),
      byteLength: 1,
      mediaType: "text/plain",
    });
  }
  const result = await new SqliteSearchRepository(db).search({
    text: "Synthetic",
    mode: "keyword",
    limit: 10,
    sessionId: id(1),
    to: "2026-11-16T23:59:59.000Z",
  });
  expect(result).toMatchObject({
    ok: true,
    value: [
      { source: { fileId: id(6), fileVersionId: id(10) }, occurredAt: time },
    ],
  });
});
it("enforces checkpoint time filters", async () => {
  db.prepare(
    "INSERT INTO checkpoints (id, session_id, name, created_at, project_references) VALUES (?, ?, ?, ?, ?)",
  ).run(id(8), id(1), "Synthetic", time, "[]");
  expect(
    await new SqliteSearchRepository(db).search({
      text: "Synthetic",
      mode: "keyword",
      limit: 10,
      from: "2026-11-17T10:00:00.000Z",
    }),
  ).toEqual({ ok: true, value: [] });
});
it("treats search wildcard characters literally", async () => {
  await new SqliteActivityRepository(db).append([event]);
  expect(
    await new SqliteSearchRepository(db).search({
      text: "%",
      mode: "keyword",
      limit: 10,
    }),
  ).toEqual({ ok: true, value: [] });
});
it("rejects unsupported search modes and invalid limits instead of broad retrieval", async () => {
  const repo = new SqliteSearchRepository(db);
  expect(
    (
      await repo.search({
        text: "Synthetic",
        mode: "natural-language",
        limit: 10,
      })
    ).ok,
  ).toBe(false);
  expect(
    (await repo.search({ text: "Synthetic", mode: "keyword", limit: -1 })).ok,
  ).toBe(false);
});
it("paginates every event at an equal timestamp using a composite cursor", async () => {
  const repo = new SqliteActivityRepository(db);
  await repo.append([event, { ...event, id: id(3) }, { ...event, id: id(4) }]);
  const found: string[] = [];
  let cursor: { occurredAt: string; id: string } | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await repo.list(id(1), 1, cursor);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.length) break;
    const last = result.value[0]!;
    found.push(last.id);
    cursor = { occurredAt: last.occurredAt, id: last.id };
  }
  expect(found).toEqual([id(4), id(3), id(2)]);
});
