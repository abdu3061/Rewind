import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { afterEach, expect, it } from "vitest";
import {
  createDefaultSettings,
  type ActivityEvent,
  type Checkpoint,
} from "@rewind/contracts";
import { SecureStorage } from "./secure-storage";
import {
  newSecureFixture,
  removeSecureFixture,
} from "./secure-fixtures.test-support";

const roots: string[] = [];
const stores: SecureStorage[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) removeSecureFixture(root);
});
async function fixture() {
  const root = newSecureFixture();
  roots.push(root);
  const file = join(root, "history.sqlite");
  const key = randomBytes(32);
  const store = new SecureStorage(file, key);
  stores.push(store);
  expect((await store.open()).ok).toBe(true);
  const sessionId = randomUUID();
  await store.repositories.sessions.save({
    id: sessionId,
    status: "active",
    startedAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
    endedAt: null,
  });
  const event = (occurredAt: string, text: string): ActivityEvent => ({
    id: randomUUID(),
    sessionId,
    occurredAt,
    type: "foreground",
    source: "windows",
    payload: { application: "Synthetic.exe", windowTitle: text },
  });
  const inspect = () => {
    const db = new NativeDatabase(file);
    db.pragma("cipher=sqlcipher");
    db.pragma("legacy=4");
    db.key(key);
    db.pragma("foreign_keys=ON");
    return db;
  };
  return { store, root, file, key, sessionId, event, inspect };
}
const now = new Date("2026-11-17T10:00:00.000Z");

it("expires old history and FTS entries, retains the boundary, persists settings and survives reopen", async () => {
  const f = await fixture();
  const old = f.event("2026-11-14T09:59:59.999Z", "expiredmarker");
  const boundary = f.event("2026-11-14T10:00:00.000Z", "retainedmarker");
  await f.store.repositories.activities.append([old, boundary]);
  expect(await f.store.cleanup(now)).toMatchObject({
    ok: true,
    value: { activityCount: 1, overQuota: false },
  });
  expect(await f.store.timeline({ limit: 10, text: "expiredmarker" })).toEqual({
    ok: true,
    value: [],
  });
  expect(await f.store.timeline({ limit: 10 })).toEqual({
    ok: true,
    value: [boundary],
  });
  expect(
    (
      await f.store.saveSettings({
        ...createDefaultSettings(),
        retentionHours: 24,
      })
    ).ok,
  ).toBe(true);
  await f.store.close();
  const reopened = new SecureStorage(f.file, f.key);
  stores.push(reopened);
  expect((await reopened.open()).ok).toBe(true);
  expect(await reopened.getSettings()).toMatchObject({
    ok: true,
    value: { retentionHours: 24 },
  });
  expect(await reopened.cleanup(now)).toMatchObject({
    ok: true,
    value: { activityCount: 0 },
  });
});

async function pinnedFixture() {
  const f = await fixture();
  const fileId = randomUUID(),
    versionId = randomUUID();
  await f.store.repositories.files.saveReference({
    id: fileId,
    displayName: "synthetic.txt",
    identity: {
      kind: "verified-path",
      absolutePath: join(f.root, "synthetic.txt"),
      verifiedAt: "2026-11-10T10:00:00.000Z",
    },
  });
  await f.store.repositories.files.addVersion({
    id: versionId,
    sessionId: f.sessionId,
    fileId,
    capturedAt: "2026-11-10T10:00:00.000Z",
    contentHash: "a".repeat(64),
    byteLength: 12,
    mediaType: "text/plain",
  });
  const checkpoint: Checkpoint = {
    id: randomUUID(),
    sessionId: f.sessionId,
    name: "Kept evidence",
    createdAt: "2026-11-10T10:00:00.000Z",
    kept: true,
    fileVersionIds: [versionId],
    browserVisitIds: [],
    projectReferences: [],
  };
  expect((await f.store.repositories.checkpoints.save(checkpoint)).ok).toBe(
    true,
  );
  return { ...f, versionId, checkpoint };
}
it("pins kept versions transitively and only deletes them after explicit inclusion", async () => {
  const f = await pinnedFixture();
  expect(await f.store.cleanup(now)).toMatchObject({
    ok: true,
    value: { versionCount: 1, keptCheckpointCount: 1 },
  });
  expect(
    await f.store.deleteHistory({ confirmed: true, includeKept: false }),
  ).toMatchObject({
    ok: true,
    value: { versionCount: 1, keptCheckpointCount: 1 },
  });
  expect(await f.store.repositories.checkpoints.get(f.checkpoint.id)).toEqual({
    ok: true,
    value: f.checkpoint,
  });
  expect(
    await f.store.deleteHistory({ confirmed: true, includeKept: true }),
  ).toMatchObject({ ok: true, value: { versionCount: 0, checkpointCount: 0 } });
  const db = f.inspect();
  try {
    expect(db.prepare("SELECT count(*) AS n FROM files").get()).toEqual({
      n: 0,
    });
  } finally {
    db.close();
  }
});
it("rejects dangling or wrong-session checkpoint evidence atomically", async () => {
  const f = await pinnedFixture();
  const result = await f.store.repositories.checkpoints.save({
    ...f.checkpoint,
    id: randomUUID(),
    browserVisitIds: [randomUUID()],
  });
  expect(result.ok).toBe(false);
  expect(await f.store.usage()).toMatchObject({
    ok: true,
    value: { checkpointCount: 1 },
  });
  const id = randomUUID();
  await f.store.repositories.sessions.save({
    id,
    status: "active",
    startedAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
    endedAt: null,
  });
  expect(
    (
      await f.store.repositories.checkpoints.save({
        ...f.checkpoint,
        id: randomUUID(),
        sessionId: id,
      })
    ).ok,
  ).toBe(false);
});

it("reports uncollectable quota pressure without deleting kept evidence", async () => {
  const f = await pinnedFixture();
  const db = f.inspect();
  try {
    // Simulate encrypted storage overhead that evidence eviction cannot remove.
    db.exec(
      "CREATE TABLE synthetic_overhead(bytes BLOB); INSERT INTO synthetic_overhead VALUES(zeroblob(17000000));",
    );
  } finally {
    db.close();
  }
  await f.store.saveSettings({
    ...createDefaultSettings(),
    storageLimitBytes: 16 * 1024 ** 2,
  });
  expect(await f.store.cleanup(now)).toMatchObject({
    ok: true,
    value: { overQuota: true, keptCheckpointCount: 1, versionCount: 1 },
  });
  expect(await f.store.repositories.checkpoints.get(f.checkpoint.id)).toEqual({
    ok: true,
    value: f.checkpoint,
  });
});

it("reports busy journal compaction honestly and can retry after the reader releases", async () => {
  const f = await fixture();
  await f.store.repositories.activities.append([
    f.event("2026-11-10T10:00:00.000Z", "expiredbusy"),
  ]);
  const reader = f.inspect();
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM activities").get();
    expect((await f.store.cleanup(now)).ok).toBe(false);
    // Logical removal committed; unsuccessful compaction must not claim all-or-nothing deletion.
    expect(await f.store.timeline({ limit: 10 })).toEqual({
      ok: true,
      value: [],
    });
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
  expect(await f.store.cleanup(now)).toMatchObject({
    ok: true,
    value: { activityCount: 0 },
  });
});
it("scopes deletion, removes search terms and reports a failed transaction without losing retained records", async () => {
  const f = await fixture();
  const first = f.event(now.toISOString(), "PrivateSyntheticMarker");
  await f.store.repositories.activities.append([first]);
  expect(
    await f.store.deleteHistory({
      sessionId: randomUUID(),
      confirmed: true,
      includeKept: true,
    }),
  ).toMatchObject({ ok: true, value: { activityCount: 1 } });
  const db = f.inspect();
  db.exec(
    "CREATE TRIGGER fail_delete BEFORE DELETE ON activities BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
  );
  try {
    expect(
      (await f.store.deleteHistory({ confirmed: true, includeKept: true })).ok,
    ).toBe(false);
    expect(await f.store.timeline({ limit: 10 })).toEqual({
      ok: true,
      value: [first],
    });
    db.exec("DROP TRIGGER fail_delete");
  } finally {
    db.close();
  }
  expect(
    await f.store.deleteHistory({
      sessionId: f.sessionId,
      confirmed: true,
      includeKept: true,
    }),
  ).toMatchObject({ ok: true, value: { activityCount: 0 } });
  expect(
    await f.store.timeline({ limit: 10, text: "PrivateSyntheticMarker" }),
  ).toEqual({ ok: true, value: [] });
  for (const name of readdirSync(f.root))
    expect(
      readFileSync(join(f.root, name)).includes(
        Buffer.from("PrivateSyntheticMarker"),
      ),
    ).toBe(false);
});
it("accounts for WAL bytes and enforces quota oldest-first while keeping valid recent data", async () => {
  const f = await fixture();
  // Generated valid bounded events, never personal files or titles.
  const db = f.inspect();
  try {
    const insert = db.prepare("INSERT INTO activities VALUES (?,?,?,?,?,?)");
    db.transaction(() => {
      for (let i = 0; i < 7000; i++) {
        const e = f.event(
          new Date(now.getTime() + i).toISOString(),
          "x".repeat(2000),
        );
        insert.run(
          e.id,
          e.sessionId,
          e.type,
          e.source,
          e.occurredAt,
          JSON.stringify(e.payload),
        );
      }
    })();
  } finally {
    db.close();
  }
  await f.store.saveSettings({
    ...createDefaultSettings(),
    storageLimitBytes: 16 * 1024 ** 2,
  });
  const before = await f.store.usage();
  expect(before.ok && before.value.overQuota).toBe(true);
  const cleaned = await f.store.cleanup(now);
  expect(cleaned).toMatchObject({ ok: true, value: { overQuota: false } });
  expect(cleaned.ok && cleaned.value.activityCount).toBeGreaterThan(0);
  expect(cleaned.ok && cleaned.value.activityCount).toBeLessThan(7000);
  await f.store.close();
  const reopened = new SecureStorage(f.file, f.key);
  stores.push(reopened);
  expect((await reopened.open()).ok).toBe(true);
  expect((await reopened.timeline({ limit: 100 })).ok).toBe(true);
}, 30000);
