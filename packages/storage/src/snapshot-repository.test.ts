import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { afterEach, expect, it } from "vitest";
import {
  createDefaultSettings,
  type ActivityEvent,
  type SnapshotCapture,
} from "@rewind/contracts";
import { SecureStorage } from "./secure-storage";
import {
  newSecureFixture,
  removeSecureFixture,
} from "./secure-fixtures.test-support";

const roots: string[] = [],
  stores: SecureStorage[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) removeSecureFixture(root);
});
async function fixture() {
  const root = newSecureFixture();
  roots.push(root);
  const file = join(root, "history.sqlite"),
    key = randomBytes(32);
  const store = new SecureStorage(file, key);
  stores.push(store);
  expect((await store.open()).ok).toBe(true);
  const sessionId = randomUUID(),
    folderId = randomUUID();
  await store.repositories.sessions.save({
    id: sessionId,
    status: "active",
    startedAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
    endedAt: null,
  });
  expect(
    (
      await store.snapshots.saveFolder({
        id: folderId,
        absolutePath: root,
        osIdentity: "synthetic-volume:folder",
        selectedAt: "2026-11-10T10:00:00.000Z",
      })
    ).ok,
  ).toBe(true);
  function capture(
    bytes = Buffer.from("SyntheticOriginalBytes8457\0\xff", "latin1"),
    name = "synthetic.docx",
  ): SnapshotCapture {
    const fileId = randomUUID(),
      at = "2026-11-10T10:01:00.000Z";
    return {
      file: {
        id: fileId,
        displayName: name,
        identity: {
          kind: "verified-path",
          absolutePath: join(root, name),
          verifiedAt: at,
        },
      },
      version: {
        id: randomUUID(),
        sessionId,
        fileId,
        capturedAt: at,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
        mediaType: "application/octet-stream",
      },
      binding: {
        folderId,
        relativePath: name,
        osIdentity: "synthetic-volume:file",
      },
      bytes,
    };
  }
  function event(value: SnapshotCapture): ActivityEvent {
    return {
      id: randomUUID(),
      sessionId,
      occurredAt: value.version.capturedAt,
      type: "file-change",
      source: "filesystem",
      payload: { fileId: value.file.id, change: "updated" },
    };
  }
  function inspect() {
    const db = new NativeDatabase(file);
    db.pragma("cipher=sqlcipher");
    db.pragma("legacy=4");
    db.key(key);
    db.pragma("foreign_keys=ON");
    return db;
  }
  return {
    root,
    file,
    key,
    store,
    sessionId,
    folderId,
    capture,
    event,
    inspect,
  };
}
it("preserves every original binary byte encrypted and verified across a database restart", async () => {
  const f = await fixture(),
    value = f.capture();
  expect(
    await f.store.snapshots.capture(value, f.event(value), () => true),
  ).toEqual({ ok: true, value: value.version });
  const first = await f.store.snapshots.read(value.version.id);
  expect(first.ok && Buffer.from(first.value.bytes)).toEqual(
    Buffer.from(value.bytes),
  );
  for (const name of readdirSync(f.root))
    expect(
      readFileSync(join(f.root, name)).includes(
        Buffer.from("SyntheticOriginalBytes8457"),
      ),
    ).toBe(false);
  await f.store.close();
  const reopened = new SecureStorage(f.file, f.key);
  stores.push(reopened);
  expect((await reopened.open()).ok).toBe(true);
  const result = await reopened.snapshots.read(value.version.id);
  expect(result.ok && Buffer.from(result.value.bytes)).toEqual(
    Buffer.from(value.bytes),
  );
  expect(await reopened.snapshots.listVersions({ limit: 10 })).toEqual({
    ok: true,
    value: [value.version],
  });
});
it("deduplicates shared bytes and identical consecutive captures, but preserves a return to an older version", async () => {
  const f = await fixture(),
    a = f.capture();
  await f.store.snapshots.capture(a, f.event(a), () => true);
  const same = {
    ...a,
    version: {
      ...a.version,
      id: randomUUID(),
      capturedAt: "2026-11-10T10:02:00.000Z",
    },
  };
  expect(
    await f.store.snapshots.capture(same, f.event(same), () => true),
  ).toEqual({ ok: true, value: a.version });
  const shared = f.capture(Buffer.from(a.bytes), "other.docx");
  await f.store.snapshots.capture(shared, f.event(shared), () => true);
  const otherBytes = Buffer.from("Changed original bytes");
  const b = {
    ...a,
    bytes: otherBytes,
    version: {
      ...a.version,
      id: randomUUID(),
      capturedAt: "2026-11-10T10:03:00.000Z",
      byteLength: otherBytes.length,
      contentHash: createHash("sha256").update(otherBytes).digest("hex"),
    },
  };
  expect((await f.store.snapshots.capture(b, f.event(b), () => true)).ok).toBe(
    true,
  );
  const back = {
    ...a,
    version: {
      ...a.version,
      id: randomUUID(),
      capturedAt: "2026-11-10T10:04:00.000Z",
    },
  };
  expect(
    await f.store.snapshots.capture(back, f.event(back), () => true),
  ).toEqual({ ok: true, value: back.version });
  const db = f.inspect();
  try {
    expect(
      db.prepare("SELECT count(*) AS n FROM snapshot_blobs").get(),
    ).toEqual({ n: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM file_versions").get()).toEqual(
      { n: 4 },
    );
  } finally {
    db.close();
  }
});
it("rolls back bytes, identities and observations on failed metadata publication or mid-capture revocation", async () => {
  const f = await fixture(),
    value = f.capture();
  const db = f.inspect();
  try {
    db.exec(
      "CREATE TRIGGER fail_version BEFORE INSERT ON file_versions BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    expect(
      (await f.store.snapshots.capture(value, f.event(value), () => true)).ok,
    ).toBe(false);
    db.exec("DROP TRIGGER fail_version");
    let checks = 0;
    expect(
      await f.store.snapshots.capture(
        value,
        f.event(value),
        () => ++checks === 1,
      ),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    for (const table of [
      "files",
      "file_versions",
      "file_bindings",
      "snapshot_blobs",
      "activities",
    ])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({
        n: 0,
      });
  } finally {
    db.close();
  }
});
it("rejects mismatched hashes, unauthorized roots, stale sessions and reused identities", async () => {
  const f = await fixture(),
    value = f.capture();
  expect(
    (
      await f.store.snapshots.capture(
        { ...value, bytes: Buffer.from("wrong") },
        f.event(value),
        () => true,
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.store.snapshots.capture(
        {
          ...value,
          binding: { ...value.binding, relativePath: "..\\elsewhere.docx" },
        },
        f.event(value),
        () => true,
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.store.snapshots.capture(
        { ...value, binding: { ...value.binding, folderId: randomUUID() } },
        f.event(value),
        () => true,
      )
    ).ok,
  ).toBe(false);
  expect(
    (await f.store.snapshots.capture(value, f.event(value), () => false)).ok,
  ).toBe(false);
  expect(
    (await f.store.snapshots.capture(value, f.event(value), () => true)).ok,
  ).toBe(true);
  const moved = {
    ...value,
    file: {
      ...value.file,
      identity: {
        kind: "verified-path" as const,
        absolutePath: join(f.root, "other.docx"),
        verifiedAt: value.version.capturedAt,
      },
    },
    binding: { ...value.binding, relativePath: "other.docx" },
  };
  expect(
    (await f.store.snapshots.capture(moved, f.event(moved), () => true)).ok,
  ).toBe(false);
  const session = await f.store.repositories.sessions.get(f.sessionId);
  if (!session.ok || !session.value) throw new Error("Fixture session missing");
  await f.store.repositories.sessions.save({
    ...session.value,
    status: "paused",
  });
  expect(
    (await f.store.snapshots.capture(value, f.event(value), () => true)).ok,
  ).toBe(false);
});
it("refuses corrupt captured bytes and never presents legacy metadata as recoverable", async () => {
  const f = await fixture(),
    value = f.capture();
  await f.store.repositories.files.saveReference(value.file);
  await f.store.repositories.files.addVersion(value.version);
  expect(await f.store.snapshots.listVersions({ limit: 10 })).toEqual({
    ok: true,
    value: [],
  });
  expect(await f.store.snapshots.read(value.version.id)).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  const actual = { ...value, version: { ...value.version, id: randomUUID() } };
  expect(
    (await f.store.snapshots.capture(actual, f.event(actual), () => true)).ok,
  ).toBe(true);
  const db = f.inspect();
  try {
    db.exec("DROP TRIGGER snapshot_blob_immutable");
    db.prepare("UPDATE snapshot_blobs SET bytes=?").run(
      Buffer.alloc(value.bytes.length),
    );
  } finally {
    db.close();
  }
  expect(await f.store.snapshots.read(actual.version.id)).toMatchObject({
    ok: false,
    error: { code: "INTEGRITY_FAILURE" },
  });
});
it("keeps a shared blob until its final kept reference is explicitly deleted", async () => {
  const f = await fixture(),
    a = f.capture(),
    b = f.capture(Buffer.from(a.bytes), "other.docx");
  await f.store.snapshots.capture(a, f.event(a), () => true);
  await f.store.snapshots.capture(b, f.event(b), () => true);
  await f.store.repositories.checkpoints.save({
    id: randomUUID(),
    sessionId: f.sessionId,
    name: "Keep actual bytes",
    createdAt: a.version.capturedAt,
    kept: true,
    activityIds: [],
    fileVersionIds: [a.version.id],
    browserVisitIds: [],
    projectReferences: [],
  });
  expect(
    await f.store.cleanup(new Date("2026-11-17T10:00:00.000Z")),
  ).toMatchObject({ ok: true, value: { versionCount: 1 } });
  expect((await f.store.snapshots.read(a.version.id)).ok).toBe(true);
  expect((await f.store.snapshots.read(b.version.id)).ok).toBe(false);
  await f.store.deleteHistory({ confirmed: true, includeKept: false });
  expect((await f.store.snapshots.read(a.version.id)).ok).toBe(true);
  await f.store.deleteHistory({ confirmed: true, includeKept: true });
  const db = f.inspect();
  try {
    expect(
      db.prepare("SELECT count(*) AS n FROM snapshot_blobs").get(),
    ).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
it("resolves persisted file IDs without Unicode normalization and refreshes verified unchanged bytes for retention", async () => {
  const f = await fixture();
  await f.store.saveSettings({ ...createDefaultSettings(), retentionHours: 1 });
  const a = f.capture(Buffer.from("unchanged"), "\u0130.txt"),
    b = f.capture(Buffer.from("other"), "i\u0307.txt");
  await f.store.snapshots.capture(a, f.event(a), () => true);
  await f.store.snapshots.capture(b, f.event(b), () => true);
  expect(
    await f.store.snapshots.resolveFileId(f.folderId, "\u0130.txt"),
  ).toEqual({ ok: true, value: a.file.id });
  expect(
    await f.store.snapshots.resolveFileId(f.folderId, "i\u0307.txt"),
  ).toEqual({ ok: true, value: b.file.id });
  const fresh = {
    ...a,
    version: {
      ...a.version,
      id: randomUUID(),
      capturedAt: "2026-11-10T10:21:00.000Z",
    },
  };
  expect(
    await f.store.snapshots.capture(fresh, f.event(fresh), () => true),
  ).toEqual({ ok: true, value: fresh.version });
  await f.store.cleanup(new Date("2026-11-10T11:10:00.000Z"));
  expect(await f.store.snapshots.info(a.version.id)).toEqual({
    ok: true,
    value: null,
  });
  expect(await f.store.snapshots.info(fresh.version.id)).toEqual({
    ok: true,
    value: fresh.version,
  });
  expect((await f.store.snapshots.read(fresh.version.id)).ok).toBe(true);
});
it("enforces capture admission headroom and enumerates equal-time versions without losses", async () => {
  const f = await fixture();
  await f.store.saveSettings({
    ...createDefaultSettings(),
    storageLimitBytes: 16 * 1024 ** 2,
  });
  const oversized = f.capture(Buffer.alloc(4 * 1024 ** 2, 17));
  expect(
    await f.store.snapshots.capture(oversized, f.event(oversized), () => true),
  ).toMatchObject({ ok: false, error: { code: "STORAGE_LIMIT" } });
  const a = f.capture(),
    b = f.capture(Buffer.from("second"), "second.txt");
  await f.store.snapshots.capture(a, f.event(a), () => true);
  await f.store.snapshots.capture(b, f.event(b), () => true);
  const first = await f.store.snapshots.listVersions({ limit: 1 });
  if (!first.ok || !first.value[0]) throw new Error("Missing fixture version");
  const v = first.value[0];
  const second = await f.store.snapshots.listVersions({
    limit: 1,
    before: { capturedAt: v.capturedAt, id: v.id },
  });
  expect(second.ok && second.value.length).toBe(1);
  expect(second.ok && second.value[0]?.id).not.toBe(v.id);
});
