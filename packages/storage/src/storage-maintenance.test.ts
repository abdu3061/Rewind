import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  type ActivityEvent,
  type Checkpoint,
} from "@rewind/contracts";
import { SecureStorage } from "./secure-storage";
import type { EvidenceMutation } from "./storage-maintenance";
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
async function fixture(evidenceChanged?: (mutation: EvidenceMutation) => void) {
  const root = newSecureFixture();
  roots.push(root);
  const file = join(root, "history.sqlite");
  const key = randomBytes(32);
  const store = new SecureStorage(
    file,
    key,
    evidenceChanged ? { evidenceChanged } : {},
  );
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

it("limits retained-version inspection to the synchronous pre-commit callback", async () => {
  let mutation: EvidenceMutation | null = null;
  const f = await fixture((value) => {
    mutation = value;
    expect(value.retainsVersion(randomUUID())).toBe(false);
  });
  const event = f.event(
    "2026-11-10T10:01:00.000Z",
    "Synthetic expired inspection",
  );
  expect((await f.store.repositories.activities.append([event])).ok).toBe(true);
  expect((await f.store.cleanup(now)).ok).toBe(true);
  expect(mutation).not.toBeNull();
  expect(() => mutation!.retainsVersion(randomUUID())).toThrow(
    "EVIDENCE_MUTATION_EXPIRED",
  );
});

it("reports actual checkpoint retention protection and expires a linked observation only after its newest unkept checkpoint", async () => {
  const changed = vi.fn(),
    f = await fixture(changed);
  const event = f.event("2026-11-10T10:01:00.000Z", "SyntheticLinkedRetention");
  expect((await f.store.repositories.activities.append([event])).ok).toBe(true);
  const checkpoint: Checkpoint = {
    id: randomUUID(),
    sessionId: f.sessionId,
    name: "Recent unkept checkpoint",
    createdAt: "2026-11-14T10:00:00.000Z",
    kept: false,
    fileVersionIds: [],
    activityIds: [event.id],
    browserVisitIds: [],
    projectReferences: [],
  };
  expect((await f.store.checkpoints.save(checkpoint)).ok).toBe(true);
  expect(await f.store.evidence.getRetained(event.id)).toEqual({
    ok: true,
    value: { event, kept: false, retentionAnchor: checkpoint.createdAt },
  });
  expect((await f.store.cleanup(now)).ok).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  expect((await f.store.evidence.getRetained(event.id)).ok).toBe(true);
  const olderKept = {
    ...checkpoint,
    id: randomUUID(),
    createdAt: "2026-11-10T10:02:00.000Z",
    kept: true,
  };
  expect((await f.store.checkpoints.save(olderKept)).ok).toBe(true);
  expect(await f.store.evidence.getRetained(event.id)).toMatchObject({
    ok: true,
    value: { kept: true, retentionAnchor: checkpoint.createdAt },
  });
  expect((await f.store.cleanup(new Date(now.getTime() + 1))).ok).toBe(true);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(await f.store.evidence.getRetained(event.id)).toEqual({
    ok: true,
    value: { event, kept: true, retentionAnchor: olderKept.createdAt },
  });
  expect(
    (await f.store.checkpoints.save({ ...olderKept, kept: false })).ok,
  ).toBe(true);
  expect((await f.store.cleanup(now)).ok).toBe(true);
  expect(await f.store.evidence.getRetained(event.id)).toEqual({
    ok: true,
    value: null,
  });
  expect(changed).toHaveBeenCalledTimes(2);
});

it("recognizes browser checkpoint protection by the actual activity ID across encrypted reopen", async () => {
  const f = await fixture();
  const event: ActivityEvent = {
    id: randomUUID(),
    sessionId: f.sessionId,
    occurredAt: "2026-11-10T10:01:00.000Z",
    type: "browser-visit",
    source: "browser",
    payload: {
      id: randomUUID(),
      sessionId: f.sessionId,
      browser: "chrome",
      title: "Synthetic browser retention",
      url: "https://example.test/retention",
      visitedAt: "2026-11-10T10:01:00.000Z",
      endedAt: null,
    },
  };
  expect((await f.store.repositories.activities.append([event])).ok).toBe(true);
  const checkpoint: Checkpoint = {
    id: randomUUID(),
    sessionId: f.sessionId,
    name: "Browser checkpoint",
    createdAt: "2026-11-10T10:02:00.000Z",
    kept: true,
    fileVersionIds: [],
    activityIds: [event.id],
    browserVisitIds: [event.id],
    projectReferences: [],
  };
  expect((await f.store.checkpoints.save(checkpoint)).ok).toBe(true);
  expect((await f.store.cleanup(now)).ok).toBe(true);
  await f.store.close();
  const reopened = new SecureStorage(f.file, f.key);
  stores.push(reopened);
  expect((await reopened.open()).ok).toBe(true);
  expect(await reopened.evidence.getRetained(event.id)).toEqual({
    ok: true,
    value: { event, kept: true, retentionAnchor: checkpoint.createdAt },
  });
  expect(await reopened.evidence.getRetained(event.payload.id)).toEqual({
    ok: true,
    value: null,
  });
  expect((await reopened.evidence.getRetained("invalid-id")).ok).toBe(false);
});

it("invalidates evidence synchronously before deletion commits and rolls back if invalidation fails", async () => {
  const changed = vi.fn<() => void>(() => {
    const reader = f.inspect();
    try {
      // A separate WAL reader still sees the old committed record while the invalidation runs.
      expect(
        reader.prepare("SELECT count(*) AS n FROM activities").get(),
      ).toEqual({ n: 1 });
    } finally {
      reader.close();
    }
  });
  const f = await fixture(changed);
  const event = f.event("2026-11-10T10:01:00.000Z", "SyntheticBeforeCommit");
  expect((await f.store.repositories.activities.append([event])).ok).toBe(true);
  expect((await f.store.usage()).ok).toBe(true);
  expect((await f.store.evidence.getRetained(event.id)).ok).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  changed.mockImplementationOnce(() => {
    throw new Error("SYNTHETIC_INVALIDATION_FAILED");
  });
  expect((await f.store.cleanup(now)).ok).toBe(false);
  expect(await f.store.evidence.get(event.id)).toEqual({
    ok: true,
    value: event,
  });
  expect((await f.store.cleanup(now)).ok).toBe(true);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(await f.store.evidence.getRetained(event.id)).toEqual({
    ok: true,
    value: null,
  });
  expect((await f.store.cleanup(now)).ok).toBe(true);
  expect(
    (await f.store.deleteHistory({ confirmed: true, includeKept: true })).ok,
  ).toBe(true);
  expect(changed).toHaveBeenCalledTimes(2);
  expect((await f.store.repositories.activities.append([event])).ok).toBe(true);
  expect(
    (await f.store.deleteHistory({ confirmed: true, includeKept: true })).ok,
  ).toBe(true);
  expect(changed).toHaveBeenCalledTimes(3);
});

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
    activityIds: [],
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
it("pins actual non-browser activity and FTS through checkpoint expiry, then expires it after Unkeep", async () => {
  const f = await fixture(),
    selected = f.event("2026-11-10T10:01:00.000Z", "KeptActivityEvidence9382"),
    unselected = f.event("2026-11-10T10:02:00.000Z", "UnselectedEvidence9382");
  expect(
    (await f.store.repositories.activities.append([selected, unselected])).ok,
  ).toBe(true);
  const checkpoint: Checkpoint = {
    id: randomUUID(),
    sessionId: f.sessionId,
    name: "Real selected activity",
    createdAt: "2026-11-10T10:03:00.000Z",
    kept: true,
    fileVersionIds: [],
    activityIds: [selected.id],
    browserVisitIds: [],
    projectReferences: [],
  };
  expect((await f.store.checkpoints.save(checkpoint)).ok).toBe(true);
  expect(await f.store.cleanup(now)).toMatchObject({
    ok: true,
    value: { activityCount: 1, keptCheckpointCount: 1 },
  });
  expect(await f.store.evidence.get(selected.id)).toEqual({
    ok: true,
    value: selected,
  });
  expect(await f.store.evidence.get(unselected.id)).toEqual({
    ok: true,
    value: null,
  });
  expect(
    await f.store.timeline({ limit: 10, text: "KeptActivityEvidence9382" }),
  ).toMatchObject({ ok: true, value: [selected] });
  await f.store.close();
  const reopened = new SecureStorage(f.file, f.key);
  stores.push(reopened);
  expect((await reopened.open()).ok).toBe(true);
  expect(await reopened.checkpoints.get(checkpoint.id)).toEqual({
    ok: true,
    value: checkpoint,
  });
  expect(
    (await reopened.checkpoints.save({ ...checkpoint, kept: false })).ok,
  ).toBe(true);
  expect(await reopened.cleanup(now)).toMatchObject({
    ok: true,
    value: { activityCount: 0, checkpointCount: 0 },
  });
  expect(
    await reopened.timeline({ limit: 10, text: "KeptActivityEvidence9382" }),
  ).toEqual({ ok: true, value: [] });
});
it("rejects duplicate, missing and wrong-session checkpoint activity atomically and pages equal-time manifests", async () => {
  const f = await fixture(),
    selected = f.event("2026-11-10T10:01:00.000Z", "CheckpointEvidencePaging"),
    otherId = randomUUID();
  expect((await f.store.repositories.activities.append([selected])).ok).toBe(
    true,
  );
  expect(
    (
      await f.store.repositories.sessions.save({
        id: otherId,
        startedAt: "2026-11-10T10:00:00.000Z",
        updatedAt: "2026-11-10T10:00:00.000Z",
        endedAt: null,
        status: "active",
      })
    ).ok,
  ).toBe(true);
  const base: Checkpoint = {
    id: randomUUID(),
    sessionId: f.sessionId,
    name: "Synthetic evidence manifest",
    createdAt: "2026-11-10T10:03:00.000Z",
    kept: true,
    fileVersionIds: [],
    activityIds: [selected.id],
    browserVisitIds: [],
    projectReferences: [],
  };
  for (const bad of [
    { ...base, activityIds: [selected.id, selected.id] },
    { ...base, activityIds: [randomUUID()] },
    { ...base, sessionId: otherId },
  ])
    expect((await f.store.checkpoints.save(bad)).ok).toBe(false);
  expect(await f.store.checkpoints.query({ limit: 10 })).toEqual({
    ok: true,
    value: [],
  });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids)
    expect((await f.store.checkpoints.save({ ...base, id })).ok).toBe(true);
  const first = await f.store.checkpoints.query({
    limit: 2,
    sessionId: f.sessionId,
  });
  if (!first.ok) throw new Error("Synthetic paging failed");
  const last = first.value.at(-1)!;
  const second = await f.store.checkpoints.query({
    limit: 2,
    before: { createdAt: last.createdAt, id: last.id },
  });
  if (!second.ok) throw new Error("Synthetic paging failed");
  expect([...first.value, ...second.value].map((value) => value.id)).toEqual(
    ids.sort().reverse(),
  );
  expect(
    first.value.every(
      (value) => value.activityCount === 1 && value.fileVersionCount === 0,
    ),
  ).toBe(true);
  expect(
    await f.store.checkpoints.query({ limit: 10, sessionId: otherId }),
  ).toEqual({ ok: true, value: [] });
  expect((await f.store.checkpoints.remove(last.id)).ok).toBe(true);
  expect(await f.store.checkpoints.get(last.id)).toEqual({
    ok: true,
    value: null,
  });
});
it("refuses encrypted restart when checkpoint membership guards have disappeared", async () => {
  const f = await fixture();
  await f.store.close();
  const inspection = f.inspect();
  inspection.exec("DROP TRIGGER checkpoint_activity_membership");
  inspection.close();
  const reopened = new SecureStorage(f.file, f.key);
  stores.push(reopened);
  expect((await reopened.open()).ok).toBe(false);
  expect(() => reopened.checkpoints).toThrow();
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
  const changed = vi.fn(),
    f = await fixture(changed);
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
  expect(changed).not.toHaveBeenCalled();
  const cleaned = await f.store.cleanup(now);
  expect(cleaned).toMatchObject({ ok: true, value: { overQuota: false } });
  expect(changed).toHaveBeenCalled();
  expect(cleaned.ok && cleaned.value.activityCount).toBeGreaterThan(0);
  expect(cleaned.ok && cleaned.value.activityCount).toBeLessThan(7000);
  await f.store.close();
  const reopened = new SecureStorage(f.file, f.key);
  stores.push(reopened);
  expect((await reopened.open()).ok).toBe(true);
  expect((await reopened.timeline({ limit: 100 })).ok).toBe(true);
}, 30000);
