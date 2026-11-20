import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { WindowsProtectedFileAccess } from "@rewind/collectors";
import {
  automaticRecordingResponseSchema,
  versionListResponseSchema,
  type AutomaticFolder,
} from "@rewind/contracts";
import { WorkerRuntime } from "./worker-runtime";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

const profiles: string[] = [];
const runtimes: WorkerRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const profile of profiles.splice(0)) removeSecureFixture(profile);
});
function fixture() {
  const profile = newSecureFixture();
  profiles.push(profile);
  const key = randomBytes(32);
  const locations: AutomaticFolder[] = (
    ["Desktop", "Documents", "Downloads"] as const
  ).map((name) => ({ name, path: join(profile, name) }));
  for (const location of locations) mkdirSync(location.path);
  const create = (automaticFolders = locations) => {
    const runtime = new WorkerRuntime({
      root: join(profile, "secure"),
      key: Buffer.from(key),
      synthetic: true,
      automaticFolders,
      onSnapshot: vi.fn(),
      onActivity: vi.fn(),
    });
    runtimes.push(runtime);
    return runtime;
  };
  return { profile, key, locations, create };
}
const configure = (runtime: WorkerRuntime, enabled: boolean) =>
  runtime.execute({ kind: "recording.configure", enabled, confirmed: true });
const versions = async (runtime: WorkerRuntime) => {
  const result = versionListResponseSchema.parse(
    await runtime.execute({ kind: "versions.list", query: { limit: 100 } }),
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

it("requires a new explicit combined approval and does not inherit old launch grants", async () => {
  const f = fixture(),
    runtime = f.create();
  expect((await runtime.initialize()).ok).toBe(true);
  await runtime.restoreAutomaticRecording();
  expect(runtime.snapshot()).toMatchObject({
    automaticRecording: false,
    collection: "off",
    filePermission: false,
    preferences: { collectionConsent: false },
  });
  expect(
    automaticRecordingResponseSchema.parse(
      await runtime.execute({ kind: "recording.state" }),
    ),
  ).toMatchObject({
    ok: true,
    value: { enabled: false, locations: f.locations },
  });
  expect(
    await runtime.execute({
      kind: "recording.configure",
      enabled: true,
    } as never),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(await versions(runtime)).toEqual([]);
});

it("automatically captures real synthetic default folders, keeps exclusions, restarts and revokes durably", async () => {
  const f = fixture(),
    runtime = f.create();
  writeFileSync(
    join(f.profile, "Desktop", "work.txt"),
    "Synthetic saved project draft",
  );
  writeFileSync(
    join(f.profile, "Documents", "private.txt"),
    "Synthetic excluded content",
  );
  mkdirSync(join(f.profile, "Downloads", "Cache"));
  writeFileSync(
    join(f.profile, "Downloads", "Cache", "cached.txt"),
    "Synthetic cache must be skipped",
  );
  writeFileSync(
    join(f.profile, "Documents", ".env"),
    "Synthetic hidden-name fixture must be skipped",
  );
  expect((await runtime.initialize()).ok).toBe(true);
  expect(
    (
      await runtime.execute({
        kind: "preferences.update",
        value: {
          collectionConsent: false,
          excludedApplications: [],
          excludedFolderPaths: [join(f.profile, "Documents", "private.txt")],
        },
      })
    ).ok,
  ).toBe(true);
  expect(await configure(runtime, true)).toMatchObject({
    ok: true,
    value: { enabled: true, issue: null },
  });
  expect(runtime.snapshot()).toMatchObject({
    automaticRecording: true,
    collection: "active",
    filePermission: true,
    browserPermission: false,
    assistant: { permission: false },
  });
  const firstSession = runtime.snapshot().session!.id;
  expect(await versions(runtime)).toEqual([]);
  writeFileSync(
    join(f.profile, "Desktop", "work.txt"),
    "Synthetic saved project draft",
  );
  await vi.waitFor(
    async () =>
      expect((await versions(runtime)).map((item) => item.displayName)).toEqual(
        ["work.txt"],
      ),
    { timeout: 15000 },
  );
  expect((await runtime.execute({ kind: "session", action: "pause" })).ok).toBe(
    true,
  );
  expect(runtime.snapshot().collection).toBe("off");
  expect(runtime.snapshot().automaticRecording).toBe(true);
  expect((await runtime.shutdown()).ok).toBe(true);
  const reopened = f.create();
  expect((await reopened.initialize()).ok).toBe(true);
  // The supervisor still receives a default-off ready handshake.
  expect(reopened.snapshot()).toMatchObject({
    automaticRecording: true,
    collection: "off",
    filePermission: false,
  });
  await reopened.restoreAutomaticRecording();
  expect(reopened.snapshot()).toMatchObject({
    collection: "active",
    filePermission: true,
  });
  expect(reopened.snapshot().session!.id).not.toBe(firstSession);
  writeFileSync(
    join(f.profile, "Desktop", "work.txt"),
    "Synthetic saved project draft",
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await versions(reopened)).toHaveLength(1);
  expect(reopened.snapshot().preferences.excludedFolderPaths).toEqual([
    join(f.profile, "Documents", "private.txt"),
  ]);
  expect((await configure(reopened, false)).ok).toBe(true);
  expect(reopened.snapshot()).toMatchObject({
    automaticRecording: false,
    collection: "off",
    filePermission: false,
    preferences: { collectionConsent: false },
  });
  expect(
    (await versions(reopened)).some((item) => item.displayName === "work.txt"),
  ).toBe(true);
  expect((await reopened.shutdown()).ok).toBe(true);
  const revoked = f.create();
  await revoked.initialize();
  await revoked.restoreAutomaticRecording();
  expect(revoked.snapshot()).toMatchObject({
    automaticRecording: false,
    collection: "off",
    filePermission: false,
  });
}, 40000);

it("does not capture outside an isolated synthetic profile or grant apps when no default folder is valid", async () => {
  const f = fixture();
  const runtime = f.create([
    { name: "Documents", path: "C:\\outside-synthetic-fixture" },
  ]);
  await runtime.initialize();
  expect(await configure(runtime, true)).toMatchObject({ ok: false });
  expect(runtime.snapshot()).toMatchObject({
    automaticRecording: false,
    collection: "off",
    filePermission: false,
    preferences: { collectionConsent: false },
  });
  expect(await versions(runtime)).toEqual([]);
});

it("adding a folder cannot silently expand remembered approval on the next launch", async () => {
  const f = fixture(),
    runtime = f.create();
  await runtime.initialize();
  expect((await configure(runtime, true)).ok).toBe(true);
  const additional = join(f.profile, "new-project");
  mkdirSync(additional);
  writeFileSync(
    join(additional, "unapproved.txt"),
    "Synthetic newly selected scope",
  );
  expect(
    (await runtime.execute({ kind: "files.add", path: additional })).ok,
  ).toBe(true);
  expect(runtime.snapshot()).toMatchObject({
    automaticRecording: false,
    filePermission: false,
    collection: "off",
  });
  expect(await versions(runtime)).toEqual([]);
  await runtime.shutdown();
  const reopened = f.create();
  await reopened.initialize();
  await reopened.restoreAutomaticRecording();
  expect(reopened.snapshot()).toMatchObject({
    automaticRecording: false,
    filePermission: false,
    collection: "off",
  });
  expect(await versions(reopened)).toEqual([]);
}, 25000);

it("keeps interrupted work paused and renews only the previously approved locations", async () => {
  const f = fixture(),
    original = f.create();
  await original.initialize();
  expect((await configure(original, true)).ok).toBe(true);
  const sessionId = original.snapshot().session!.id;
  await original.shutdown();
  const db = new NativeDatabase(join(f.profile, "secure", "history.sqlite"));
  db.pragma("cipher=sqlcipher");
  db.pragma("legacy=4");
  db.key(f.key);
  try {
    db.prepare(
      "UPDATE sessions SET status='active',ended_at=NULL WHERE id=?",
    ).run(sessionId);
  } finally {
    db.close();
  }
  const reopened = f.create([
    { name: "Documents", path: join(f.profile, "new-unapproved-location") },
  ]);
  await reopened.initialize();
  await reopened.restoreAutomaticRecording();
  expect(reopened.snapshot()).toMatchObject({
    collection: "off",
    automaticRecording: true,
    filePermission: true,
    session: { id: sessionId, status: "paused" },
  });
  expect(await reopened.execute({ kind: "recording.state" })).toMatchObject({
    ok: true,
    value: { locations: f.locations },
  });
  expect(
    (await reopened.execute({ kind: "session", action: "resume" })).ok,
  ).toBe(true);
  expect(reopened.snapshot().collection).toBe("active");
}, 25000);

it("a revoke during native default-folder validation prevents a late remembered grant", async () => {
  const f = fixture(),
    runtime = f.create();
  await runtime.initialize();
  const original = WindowsProtectedFileAccess.prototype.validateFolder;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(
    WindowsProtectedFileAccess.prototype,
    "validateFolder",
  ).mockImplementationOnce(async function (
    this: WindowsProtectedFileAccess,
    selected: string,
  ) {
    entered();
    await gate;
    return original.call(this, selected);
  });
  const pending = configure(runtime, true);
  try {
    await waiting;
    expect((await configure(runtime, false)).ok).toBe(true);
  } finally {
    release();
  }
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(runtime.snapshot()).toMatchObject({
    automaticRecording: false,
    collection: "off",
    filePermission: false,
  });
}, 20000);

it("refuses automatic capture if remembered-approval persistence fails", async () => {
  const f = fixture(),
    runtime = f.create();
  await runtime.initialize();
  const db = new NativeDatabase(join(f.profile, "secure", "history.sqlite"));
  db.pragma("cipher=sqlcipher");
  db.pragma("legacy=4");
  db.key(f.key);
  try {
    db.exec(
      "CREATE TRIGGER refuse_automatic BEFORE UPDATE ON runtime_settings WHEN json_extract(NEW.payload,'$.automaticRecording')=1 BEGIN SELECT RAISE(FAIL,'synthetic'); END;",
    );
    expect((await configure(runtime, true)).ok).toBe(false);
    expect(runtime.snapshot()).toMatchObject({
      automaticRecording: false,
      filePermission: false,
      preferences: { collectionConsent: false },
    });
    expect(await versions(runtime)).toEqual([]);
  } finally {
    db.close();
  }
}, 25000);
