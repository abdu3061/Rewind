import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  createDefaultSettings,
  type Collector,
  type CollectorContext,
  type Result,
} from "@rewind/contracts";
import { SqliteStorageAdapter } from "@rewind/storage";
import { WindowsCollector } from "@rewind/collectors";
import { vi } from "vitest";
import type { ActiveWindowInfo } from "@rewind/collectors";
import { SessionCoordinator } from "./session-coordinator";
import { SessionService } from "./session-service";

const now = "2026-11-16T10:00:00.000Z";
const migration = resolve(__dirname, "../../../db/migrations/001_initial.sql");
const adapters: SqliteStorageAdapter[] = [];
const directories: string[] = [];
const ok = async (): Promise<Result<void>> => ({ ok: true, value: undefined });
class SyntheticCollector implements Collector {
  readonly id = "synthetic";
  context: CollectorContext | null = null;
  starts = 0;
  async start(context: CollectorContext): Promise<Result<void>> {
    this.context = context;
    this.starts++;
    return ok();
  }
  resume(context: CollectorContext): Promise<Result<void>> {
    return this.start(context);
  }
  pause(): Promise<Result<void>> {
    return this.stop();
  }
  async stop(): Promise<Result<void>> {
    this.context = null;
    return ok();
  }
}
function fixture(path = ":memory:") {
  const storage = new SqliteStorageAdapter(path, migration);
  adapters.push(storage);
  const collectors = {
    windows: new SyntheticCollector(),
    browser: new SyntheticCollector(),
    folders: new SyntheticCollector(),
  };
  const coordinator = new SessionCoordinator({
    mode: "repository",
    storage,
    collectors,
    service: new SessionService({ newId: randomUUID, now: () => now }),
    getSettings: () => ({
      ...createDefaultSettings(),
      collectionConsent: true,
    }),
    authorizeResource: async () => ({ ok: true, value: undefined }), // Synthetic resource authorization only.
  });
  return { storage, collectors, coordinator };
}
function persistentPath(): string {
  const directory = mkdtempSync(resolve(tmpdir(), "rewind-lifecycle-"));
  directories.push(directory);
  return resolve(directory, "synthetic.sqlite");
}
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const directory of directories.splice(0)) {
    const scoped = relative(resolve(tmpdir()), resolve(directory));
    if (
      isAbsolute(scoped) ||
      scoped.startsWith("..") ||
      !scoped.startsWith("rewind-lifecycle-")
    )
      throw new Error("Refusing cleanup outside lifecycle fixtures.");
    rmSync(directory, { recursive: true, force: true });
  }
});

it("owns open/lifecycle/ingestion/close against real SQLite prototypes", async () => {
  const f = fixture();
  expect((await f.coordinator.execute("start")).ok).toBe(true);
  const sessionId = f.coordinator.getState().session!.id;
  const window = f.collectors.windows.context!;
  expect(
    (
      await window.emit([
        {
          id: randomUUID(),
          sessionId,
          occurredAt: now,
          type: "idle",
          source: "windows",
          payload: { state: "entered" },
        },
      ])
    ).ok,
  ).toBe(true);
  const file = {
    id: randomUUID(),
    displayName: "Synthetic file",
    identity: { kind: "unverified" as const, observedTitle: "Synthetic file" },
  };
  expect(
    (
      await f.collectors.folders.context!.emit([
        {
          id: randomUUID(),
          sessionId,
          occurredAt: now,
          type: "file-opened",
          source: "rewind",
          payload: file,
        },
      ])
    ).ok,
  ).toBe(true);
  expect(await f.storage.repositories.files.getReference(file.id)).toEqual({
    ok: true,
    value: file,
  });
  for (const action of ["pause", "resume", "end"] as const)
    expect((await f.coordinator.execute(action)).ok).toBe(true);
  expect((await window.emit([])).ok).toBe(false);
  expect(await f.storage.repositories.sessions.get(sessionId)).toMatchObject({
    ok: true,
    value: { status: "ended" },
  });
  expect(
    await f.storage.repositories.activities.list(sessionId, 10),
  ).toMatchObject({ ok: true, value: expect.any(Array) });
  expect((await f.coordinator.shutdown()).ok).toBe(true);
  expect(() => f.storage.repositories).toThrow();
});
it("reopens persisted synthetic history but never auto-resumes an interrupted session", async () => {
  const path = persistentPath();
  const first = fixture(path);
  await first.coordinator.execute("start");
  const sessionId = first.coordinator.getState().session!.id;
  await first.collectors.windows.context!.emit([
    {
      id: randomUUID(),
      sessionId,
      occurredAt: now,
      type: "idle",
      source: "windows",
      payload: { state: "entered" },
    },
  ]);
  // Simulate process loss at the persistence boundary; fake collectors have no native resources/timers.
  await first.storage.close();
  const restarted = fixture(path);
  expect(await restarted.coordinator.initialize()).toMatchObject({
    ok: true,
    value: { session: { id: sessionId, status: "paused" } },
  });
  expect(restarted.collectors.windows.starts).toBe(0);
  expect(restarted.coordinator.getActiveGenerationId()).toBeNull();
  const history = await restarted.storage.repositories.activities.list(
    sessionId,
    10,
  );
  expect(history.ok && history.value).toHaveLength(1);
  expect((await restarted.coordinator.shutdown()).ok).toBe(true);
});
it("refuses persistent initialization failure without substituting volatile repositories", async () => {
  const directory = persistentPath();
  const f = fixture(resolve(directory, "missing-parent", "synthetic.sqlite"));
  expect(await f.coordinator.execute("start")).toMatchObject({
    ok: false,
    error: { message: "Storage open failed." },
  });
  expect(f.coordinator.getState()).toEqual({ session: null });
  expect(() => f.storage.repositories).toThrow();
  expect(f.collectors.windows.starts).toBe(0);
  expect((await f.coordinator.shutdown()).ok).toBe(true);
});
it("does not publish pause when SQLite rejects the transition, then safely retries end", async () => {
  const path = persistentPath();
  const f = fixture(path);
  await f.coordinator.execute("start");
  const inspection = new DatabaseSync(path);
  try {
    inspection.exec(
      "CREATE TRIGGER reject_pause BEFORE UPDATE ON sessions WHEN NEW.status = 'paused' BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END;",
    );
    expect((await f.coordinator.execute("pause")).ok).toBe(false);
    expect(f.coordinator.getState().session?.status).toBe("active");
    expect(f.coordinator.getActiveGenerationId()).toBeNull();
    expect(
      inspection.prepare("SELECT status FROM sessions").get()?.status,
    ).toBe("active");
    inspection.exec("DROP TRIGGER reject_pause");
    expect((await f.coordinator.execute("end")).ok).toBe(true);
    expect(
      inspection.prepare("SELECT status FROM sessions").get()?.status,
    ).toBe("ended");
  } finally {
    inspection.close();
    await f.coordinator.shutdown();
  }
});
it("surfaces an actual failed SQLite append and stops source admission", async () => {
  const path = persistentPath();
  const f = fixture(path);
  await f.coordinator.execute("start");
  const inspection = new DatabaseSync(path);
  try {
    inspection.exec(
      "CREATE TRIGGER reject_append BEFORE INSERT ON activities BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END;",
    );
    const context = f.collectors.windows.context!;
    expect(
      (
        await context.emit([
          {
            id: randomUUID(),
            sessionId: context.sessionId,
            occurredAt: now,
            type: "idle",
            source: "windows",
            payload: { state: "entered" },
          },
        ])
      ).ok,
    ).toBe(false);
    expect((await context.emit([])).ok).toBe(false);
    expect(
      inspection.prepare("SELECT COUNT(*) AS count FROM activities").get()
        ?.count,
    ).toBe(0);
    expect(f.coordinator.getStatus().unavailable).toBe(true);
  } finally {
    inspection.close();
    await f.coordinator.shutdown();
  }
});
it("returns a structured failure if storage disappears during an active generation", async () => {
  const f = fixture();
  await f.coordinator.execute("start");
  const context = f.collectors.windows.context!;
  await f.storage.close();
  await expect(
    context.emit([
      {
        id: randomUUID(),
        sessionId: context.sessionId,
        occurredAt: now,
        type: "idle",
        source: "windows",
        payload: { state: "entered" },
      },
    ]),
  ).resolves.toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expect(f.coordinator.getActiveGenerationId()).toBeNull();
  expect((await f.coordinator.initialize()).ok).toBe(false);
  expect((await f.coordinator.execute("end")).ok).toBe(false);
  // Failed persistence is never replaced by a new empty database.
  expect(() => f.storage.repositories).toThrow();
});
it("drains the existing Windows adapter with SQLite using synthetic window queries only", async () => {
  const storage = new SqliteStorageAdapter(":memory:", migration);
  adapters.push(storage);
  let release!: (info: ActiveWindowInfo | null) => void;
  const query = vi.fn(async (): Promise<ActiveWindowInfo | null> => ({
    application: "Code.exe",
    windowTitle: "Synthetic",
  }));
  const windows = new WindowsCollector({
    strategy: { getActiveWindow: query },
    pollIntervalMs: 60000,
    now: () => now,
  });
  const coordinator = new SessionCoordinator({
    mode: "repository",
    storage,
    collectors: {
      windows,
      browser: new SyntheticCollector(),
      folders: new SyntheticCollector(),
    },
    service: new SessionService({ newId: randomUUID, now: () => now }),
    getSettings: () => ({
      ...createDefaultSettings(),
      collectionConsent: true,
    }),
  });
  try {
    expect((await coordinator.execute("start")).ok).toBe(true);
    expect((await windows.poll()).ok).toBe(true);
    query.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const pending = windows.poll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    let acknowledged = false;
    const pause = coordinator.execute("pause").then((result) => {
      acknowledged = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const earlyAcknowledgement = acknowledged;
    release({ application: "Other.exe", windowTitle: "Synthetic late" });
    await pending;
    expect((await pause).ok).toBe(true);
    expect(earlyAcknowledgement).toBe(false);
    const history = await storage.repositories.activities.list(
      coordinator.getState().session!.id,
      10,
    );
    expect(history.ok && history.value).toHaveLength(1);
    await coordinator.execute("resume");
    query.mockRejectedValueOnce(new Error("Synthetic native failure"));
    expect((await windows.poll()).ok).toBe(false);
    expect((await coordinator.execute("get")).ok).toBe(false);
    expect(coordinator.getStatus().unavailable).toBe(true);
    const gaps = await storage.repositories.activities.list(
      coordinator.getState().session!.id,
      10,
    );
    expect(
      gaps.ok && gaps.value.filter((event) => event.type === "capture-gap"),
    ).toHaveLength(1);
  } finally {
    await coordinator.shutdown();
  }
});
