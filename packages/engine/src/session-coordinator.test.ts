import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  failure,
  type ActivityEvent,
  type CollectorContext,
  type Result,
  type Session,
} from "@rewind/contracts";
import { SessionCoordinator } from "./session-coordinator";
import { SessionService } from "./session-service";

const now = "2026-11-16T10:00:00.000Z";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ok = async (): Promise<Result<void>> => ({ ok: true, value: undefined });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function event(n = 1): ActivityEvent {
  return {
    id: id(100 + n),
    sessionId: id(1),
    occurredAt: now,
    source: "windows",
    type: "idle",
    payload: { state: "entered" },
  };
}
function fixture(consent = true, timeout = 1000) {
  let nextId = 1;
  const service = new SessionService({
    newId: () => id(nextId++),
    now: () => now,
  });
  const settings = { ...createDefaultSettings(), collectionConsent: consent };
  const contexts: CollectorContext[] = [];
  const makeCollector = () => {
    const collector = {
      id: "synthetic",
      running: false,
      start: vi.fn(async (context: CollectorContext) => {
        contexts.push(context);
        collector.running = true;
        return ok();
      }),
      resume: vi.fn(async (context: CollectorContext) => {
        contexts.push(context);
        collector.running = true;
        return ok();
      }),
      pause: vi.fn(ok),
      stop: vi.fn(async () => {
        collector.running = false;
        return ok();
      }),
    };
    return collector;
  };
  const collectors = {
    windows: makeCollector(),
    browser: makeCollector(),
    folders: makeCollector(),
  };
  const records = new Map<string, Session>();
  const persisted: ActivityEvent[] = [];
  const repositories = {
    sessions: {
      save: vi.fn(async (session: Session): Promise<Result<void>> => {
        records.set(session.id, structuredClone(session));
        return ok();
      }),
      get: vi.fn(async (key: string): Promise<Result<Session | null>> => ({
        ok: true,
        value: records.get(key) ?? null,
      })),
      getLatest: vi.fn(async (): Promise<Result<Session | null>> => ({
        ok: true,
        value: [...records.values()].at(-1) ?? null,
      })),
    },
    activities: {
      append: vi.fn(
        async (events: readonly ActivityEvent[]): Promise<Result<void>> => {
          persisted.push(...structuredClone(events));
          return ok();
        },
      ),
      list: vi.fn(async (): Promise<Result<ActivityEvent[]>> => ({
        ok: true,
        value: structuredClone(persisted),
      })),
    },
  };
  const closeStorage = vi.fn(ok);
  const storage = { repositories, open: vi.fn(ok), close: closeStorage };
  const coordinator = new SessionCoordinator({
    mode: "repository",
    service,
    storage,
    collectors,
    getSettings: () => settings,
    newGenerationId: () => id(900),
    operationTimeoutMs: timeout,
  });
  return {
    coordinator,
    service,
    storage,
    repositories,
    collectors,
    contexts,
    records,
    persisted,
    settings,
    closeStorage,
  };
}
afterEach(() => {
  vi.useRealTimers();
});
it("interrupts collector authority even when read work saturates the lifecycle queue", async () => {
  const f = fixture();
  await f.coordinator.execute("start");
  const release = deferred();
  const entered = deferred();
  const first = f.coordinator.read(async () => {
    entered.resolve();
    await release.promise;
    return ok();
  });
  await entered.promise;
  const queued = Array.from({ length: 63 }, () => f.coordinator.read(ok));
  expect((await f.coordinator.revokeConsent()).ok).toBe(false);
  await turn();
  expect(f.collectors.windows.running).toBe(false);
  expect((await f.contexts[0]!.emit([event()])).ok).toBe(false);
  release.resolve();
  await Promise.all([first, ...queued]);
  await f.coordinator.shutdown();
});

it("serializes grant persistence with resume and lets revocation preempt both", async () => {
  const f = fixture(false);
  await f.coordinator.execute("start");
  const entered = deferred();
  const release = deferred();
  const grant = f.coordinator.updateSettings(
    { ...f.settings, collectionConsent: true },
    async () => {
      entered.resolve();
      await release.promise;
      return ok();
    },
  );
  await entered.promise;
  const resume = f.coordinator.execute("resume");
  const revoke = f.coordinator.revokeConsent();
  expect(f.coordinator.getActiveGenerationId()).toBeNull();
  expect(f.contexts).toHaveLength(0);
  release.resolve();
  expect((await grant).ok).toBe(true);
  expect((await resume).ok).toBe(false);
  expect((await revoke).ok).toBe(true);
  await f.coordinator.execute("resume");
  expect(f.contexts).toHaveLength(0);
  expect(f.coordinator.getStatus().collection).toBe("off");
  await f.coordinator.shutdown();
});

it("keeps read models behind an uncommitted lifecycle operation", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.collectors.windows.start.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return ok();
  });
  const starting = f.coordinator.execute("start");
  await entered.promise;
  const read = vi.fn(async () => ({
    ok: true as const,
    value: f.coordinator.getState(),
  }));
  const reading = f.coordinator.read(read);
  await turn();
  expect(read).not.toHaveBeenCalled();
  release.resolve();
  expect((await starting).ok).toBe(true);
  expect(await reading).toMatchObject({
    ok: true,
    value: { session: { status: "active" } },
  });
  await f.coordinator.shutdown();
});

describe("SessionCoordinator failure regressions", () => {
  it("reports session storage failure without publishing an active session", async () => {
    const f = fixture();
    f.repositories.sessions.save.mockResolvedValue(
      failure("UNAVAILABLE", "Synthetic private path"),
    );
    expect(await f.coordinator.execute("start")).toMatchObject({ ok: false });
    expect(f.coordinator.getState()).toEqual({ session: null });
    expect(f.contexts).toHaveLength(0);
    expect(f.coordinator.getStatus().unavailable).toBe(true);
  });
  it("reports partial collector startup failure and durably compensates", async () => {
    const f = fixture();
    f.collectors.browser.start.mockResolvedValue(
      failure("UNAVAILABLE", "Synthetic failure"),
    );
    expect(await f.coordinator.execute("start")).toMatchObject({ ok: false });
    expect(f.coordinator.getState()).toEqual({ session: null });
    expect(f.records.get(id(1))?.status).toBe("ended");
    expect(
      Object.values(f.collectors).every((collector) => !collector.running),
    ).toBe(true);
    expect(f.collectors.folders.start).not.toHaveBeenCalled();
    expect((await f.contexts[0]!.emit([event()])).ok).toBe(false);
  });
  it("preempts an earlier pending start and never starts sources after stop acknowledgement", async () => {
    const f = fixture();
    const saveEntered = deferred();
    const release = deferred();
    f.repositories.sessions.save.mockImplementationOnce(async () => {
      saveEntered.resolve();
      await release.promise;
      return ok();
    });
    const start = f.coordinator.execute("start");
    await saveEntered.promise;
    let acknowledged = false;
    const pause = f.coordinator.execute("pause").then((result) => {
      acknowledged = true;
      return result;
    });
    await turn();
    expect(acknowledged).toBe(false);
    release.resolve();
    expect((await start).ok).toBe(false);
    // No start committed: pause correctly reports invalid transition instead of inventing a session.
    expect(await pause).toMatchObject({
      ok: false,
      error: { code: "INVALID_TRANSITION" },
    });
    expect(f.contexts).toHaveLength(0);
    expect(f.coordinator.getActiveGenerationId()).toBeNull();
  });
  it("waits for an in-flight append before acknowledging pause", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    const entered = deferred();
    const release = deferred();
    f.repositories.activities.append.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return ok();
    });
    const emission = f.contexts[0]!.emit([event()]);
    await entered.promise;
    let acknowledged = false;
    const pause = f.coordinator.execute("pause").then((result) => {
      acknowledged = true;
      return result;
    });
    expect(f.coordinator.getActiveGenerationId()).toBeNull();
    await turn();
    expect(acknowledged).toBe(false);
    expect((await f.contexts[0]!.emit([event(2)])).ok).toBe(false);
    release.resolve();
    expect((await emission).ok).toBe(true);
    expect(await pause).toMatchObject({
      ok: true,
      value: { session: { status: "paused" } },
    });
    expect(f.records.get(id(1))?.status).toBe("paused");
  });
});

describe("lifecycle, restart and shutdown", () => {
  it("rejects storage-open failure without accessing repositories or falling back", async () => {
    const f = fixture();
    f.storage.open.mockResolvedValueOnce(
      failure("UNAVAILABLE", "Private synthetic path"),
    );
    expect(await f.coordinator.execute("start")).toMatchObject({
      ok: false,
      error: { message: "Storage open failed." },
    });
    expect(f.repositories.sessions.getLatest).not.toHaveBeenCalled();
    expect(f.contexts).toHaveLength(0);
    expect((await f.coordinator.execute("start")).ok).toBe(true);
  });
  it("rejects shutdown during partially started collectors without any late activation", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.collectors.windows.start.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      f.collectors.windows.running = true;
      return ok();
    });
    const start = f.coordinator.execute("start");
    await entered.promise;
    const shutdown = f.coordinator.shutdown();
    release.resolve();
    expect((await start).ok).toBe(false);
    expect((await shutdown).ok).toBe(true);
    expect(
      Object.values(f.collectors).every((collector) => !collector.running),
    ).toBe(true);
    expect(f.closeStorage).toHaveBeenCalledTimes(1);
  });
  it("keeps collection off without consent through a full lifecycle", async () => {
    const f = fixture(false);
    for (const action of ["start", "pause", "resume", "end"] as const)
      expect((await f.coordinator.execute(action)).ok).toBe(true);
    expect(f.contexts).toHaveLength(0);
    expect(f.coordinator.getStatus().collection).toBe("off");
    expect(f.records.get(id(1))?.status).toBe("ended");
  });
  it("rejects old contexts even when an injected generation ID repeats", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    const old = f.contexts[0]!;
    expect((await old.emit([event()])).ok).toBe(true);
    await f.coordinator.execute("pause");
    await f.coordinator.execute("resume");
    expect((await old.emit([event(2)])).ok).toBe(false);
    expect((await f.contexts[3]!.emit([event(3)])).ok).toBe(true);
    await f.coordinator.execute("end");
    expect((await f.contexts[3]!.emit([event(4)])).ok).toBe(false);
    expect(f.persisted).toHaveLength(2);
  });
  it("serializes duplicate starts and reads behind the commit point", async () => {
    const f = fixture(false);
    const entered = deferred();
    const release = deferred();
    f.repositories.sessions.save.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return ok();
    });
    const first = f.coordinator.execute("start");
    await entered.promise;
    const duplicate = f.coordinator.execute("start");
    const read = f.coordinator.execute("get");
    expect(f.coordinator.getState()).toEqual({ session: null });
    release.resolve();
    expect((await first).ok).toBe(true);
    expect(await duplicate).toMatchObject({
      ok: false,
      error: { code: "INVALID_TRANSITION" },
    });
    expect(await read).toMatchObject({
      ok: true,
      value: { session: { status: "active" } },
    });
  });
  it("loads an interrupted active session as durably paused without restarting collectors", async () => {
    const f = fixture();
    f.records.set(id(1), {
      id: id(1),
      status: "active",
      startedAt: now,
      updatedAt: now,
      endedAt: null,
    });
    expect(await f.coordinator.initialize()).toMatchObject({
      ok: true,
      value: { session: { status: "paused" } },
    });
    expect(f.records.get(id(1))?.status).toBe("paused");
    expect(f.contexts).toHaveLength(0);
  });
  it("does not publish restart state when persisting its pause fails", async () => {
    const f = fixture();
    f.records.set(id(1), {
      id: id(1),
      status: "active",
      startedAt: now,
      updatedAt: now,
      endedAt: null,
    });
    f.repositories.sessions.save.mockResolvedValue(
      failure("UNAVAILABLE", "Failure"),
    );
    expect((await f.coordinator.initialize()).ok).toBe(false);
    expect(f.coordinator.getState().session).toBeNull();
    expect(f.contexts).toHaveLength(0);
  });
  it("rejects failed reads and corrupt persisted sessions with content-free errors", async () => {
    const f = fixture();
    f.repositories.sessions.getLatest.mockRejectedValue(
      new Error("C:\\private\\synthetic"),
    );
    const result = await f.coordinator.execute("start");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: "Session load failed." },
    });
    const corrupt = fixture();
    corrupt.repositories.sessions.getLatest.mockResolvedValue({
      ok: true,
      value: { id: "invalid" } as Session,
    });
    expect(await corrupt.coordinator.initialize()).toMatchObject({
      ok: false,
      error: { code: "INTEGRITY_FAILURE" },
    });
  });
  it("compensates a rejected startup Promise and permits a later fresh start", async () => {
    const f = fixture();
    f.collectors.windows.start.mockRejectedValueOnce(
      new Error("Private upstream message"),
    );
    expect(await f.coordinator.execute("start")).toMatchObject({
      ok: false,
      error: { message: "Collector startup failed." },
    });
    expect((await f.coordinator.execute("start")).ok).toBe(true);
    expect(f.coordinator.getState().session?.id).toBe(id(2));
  });
  it("preserves the prior paused state after failed resume", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    await f.coordinator.execute("pause");
    const before = f.coordinator.getState();
    f.collectors.browser.resume.mockResolvedValue(
      failure("UNAVAILABLE", "Failure"),
    );
    expect((await f.coordinator.execute("resume")).ok).toBe(false);
    expect(f.coordinator.getState()).toEqual(before);
    expect(f.records.get(id(1))).toEqual(before.session);
    expect(
      Object.values(f.collectors).every((collector) => !collector.running),
    ).toBe(true);
  });
  it("does not acknowledge a failed stop and supports end retry after cleanup recovers", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    f.collectors.windows.stop.mockResolvedValueOnce(
      failure("UNAVAILABLE", "Failure"),
    );
    expect((await f.coordinator.execute("pause")).ok).toBe(false);
    expect(f.coordinator.getState().session?.status).toBe("active");
    expect(f.coordinator.getStatus().unavailable).toBe(true);
    expect((await f.coordinator.execute("resume")).ok).toBe(false);
    expect((await f.coordinator.execute("get")).ok).toBe(false);
    expect((await f.coordinator.execute("end")).ok).toBe(true);
    expect(f.coordinator.getStatus().unavailable).toBe(false);
  });
  it("does not publish pause on write failure and can retry end safely", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    f.repositories.sessions.save.mockRejectedValueOnce(new Error("Failure"));
    expect((await f.coordinator.execute("pause")).ok).toBe(false);
    expect(f.coordinator.getState().session?.status).toBe("active");
    expect(f.coordinator.getActiveGenerationId()).toBeNull();
    expect((await f.coordinator.execute("end")).ok).toBe(true);
  });
  it("deduplicates shutdown, ends durably before close and rejects commands afterward", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    f.closeStorage.mockImplementation(async () => {
      expect(f.records.get(id(1))?.status).toBe("ended");
      expect(
        Object.values(f.collectors).every((collector) => !collector.running),
      ).toBe(true);
      return ok();
    });
    const results = await Promise.all([
      f.coordinator.shutdown(),
      f.coordinator.shutdown(),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(f.closeStorage).toHaveBeenCalledTimes(1);
    expect((await f.coordinator.execute("start")).ok).toBe(false);
    expect((await f.coordinator.shutdown()).ok).toBe(true);
  });
  it("allows retry after failed storage close without reopening or accepting commands", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    f.closeStorage.mockResolvedValueOnce(failure("UNAVAILABLE", "Failure"));
    expect((await f.coordinator.shutdown()).ok).toBe(false);
    expect((await f.coordinator.execute("start")).ok).toBe(false);
    expect((await f.coordinator.shutdown()).ok).toBe(true);
    expect(f.closeStorage).toHaveBeenCalledTimes(2);
  });
  it("shutdown does not fabricate a hydration or mutate history in an unused instance", async () => {
    const f = fixture();
    expect((await f.coordinator.shutdown()).ok).toBe(true);
    expect(f.repositories.sessions.getLatest).not.toHaveBeenCalled();
    expect(f.repositories.sessions.save).not.toHaveBeenCalled();
  });
});

describe("permission and ingress boundaries", () => {
  it("rechecks authority after asynchronous resource validation before any write", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    let authorizations = 0;
    const coordinator = new SessionCoordinator({
      mode: "repository",
      service: f.service,
      storage: f.storage,
      collectors: f.collectors,
      getSettings: () => f.settings,
      authorizeResource: async () => {
        authorizations++;
        entered.resolve();
        await release.promise;
        return ok();
      },
    });
    await coordinator.execute("start");
    const emission = f.contexts[2]!.emit([
      {
        ...event(),
        source: "rewind",
        type: "file-opened",
        payload: {
          id: id(600),
          displayName: "Synthetic",
          identity: { kind: "unverified", observedTitle: "Synthetic" },
        },
      },
      {
        ...event(2),
        source: "rewind",
        type: "file-opened",
        payload: {
          id: id(601),
          displayName: "Synthetic second",
          identity: { kind: "unverified", observedTitle: "Synthetic second" },
        },
      },
    ]);
    await entered.promise;
    let acknowledged = false;
    const revoke = coordinator.revokeConsent().then((result) => {
      acknowledged = true;
      return result;
    });
    await turn();
    expect(acknowledged).toBe(false);
    release.resolve();
    expect((await emission).ok).toBe(false);
    expect((await revoke).ok).toBe(true);
    expect(authorizations).toBe(1);
    expect(f.repositories.activities.append).not.toHaveBeenCalled();
  });
  it("does not allow an injected resource policy to bypass separate article consent", async () => {
    const f = fixture();
    const authorize = vi.fn(ok);
    const coordinator = new SessionCoordinator({
      mode: "repository",
      service: f.service,
      storage: f.storage,
      collectors: f.collectors,
      getSettings: () => f.settings,
      authorizeResource: authorize,
    });
    await coordinator.execute("start");
    expect(
      (
        await f.contexts[1]!.emit([
          {
            ...event(),
            source: "browser",
            type: "browser-visit",
            payload: {
              id: id(600),
              sessionId: id(1),
              browser: "chrome",
              title: "Synthetic",
              url: "https://example.com",
              visitedAt: now,
              endedAt: null,
              articleText: "Synthetic",
            },
          },
        ])
      ).ok,
    ).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
    expect(f.repositories.activities.append).not.toHaveBeenCalled();
  });
  it("fails closed when the policy provider changes without the normal notification", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    f.settings.collectionConsent = false;
    expect((await f.contexts[0]!.emit([event()])).ok).toBe(false);
    await turn();
    expect(f.coordinator.getActiveGenerationId()).toBeNull();
    expect(
      Object.values(f.collectors).every((collector) => !collector.running),
    ).toBe(true);
  });
  it("revokes before draining and requires an explicit resume after regrant", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    const entered = deferred();
    const release = deferred();
    f.repositories.activities.append.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return ok();
    });
    const emission = f.contexts[0]!.emit([event()]);
    await entered.promise;
    let acknowledged = false;
    const revoke = f.coordinator.revokeConsent().then((result) => {
      acknowledged = true;
      return result;
    });
    expect((await f.contexts[0]!.emit([event(2)])).ok).toBe(false);
    await turn();
    expect(acknowledged).toBe(false);
    release.resolve();
    await emission;
    expect(await revoke).toMatchObject({
      ok: true,
      value: { session: { status: "paused" } },
    });
    await f.coordinator.updateSettings({
      ...f.settings,
      collectionConsent: true,
    });
    expect(f.coordinator.getStatus().collection).toBe("off");
    expect((await f.contexts[0]!.emit([event(3)])).ok).toBe(false);
    expect((await f.coordinator.execute("resume")).ok).toBe(true);
  });
  it("detects settings changes during startup and denies context mutation as authorization", async () => {
    const f = fixture();
    f.collectors.windows.start.mockImplementationOnce(async (context) => {
      context.settings.excludedApplications.push("mutated-copy");
      f.settings.collectionConsent = false;
      return ok();
    });
    expect((await f.coordinator.execute("start")).ok).toBe(false);
    expect(f.settings.excludedApplications).toEqual([]);
    expect(f.coordinator.getActiveGenerationId()).toBeNull();
  });
  it("rejects startup emissions before commit", async () => {
    const f = fixture();
    f.collectors.windows.start.mockImplementationOnce(async (context) => {
      expect((await context.emit([event()])).ok).toBe(false);
      return ok();
    });
    expect((await f.coordinator.execute("start")).ok).toBe(true);
    expect(f.repositories.activities.append).not.toHaveBeenCalled();
  });
  it("drops queued work after pause even if admitted before revocation", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    const entered = deferred();
    const release = deferred();
    f.repositories.activities.append.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return ok();
    });
    const first = f.contexts[0]!.emit([event()]);
    await entered.promise;
    const queued = f.contexts[0]!.emit([event(2)]);
    const pause = f.coordinator.execute("pause");
    release.resolve();
    expect((await first).ok).toBe(true);
    expect((await queued).ok).toBe(false);
    expect((await pause).ok).toBe(true);
    expect(f.repositories.activities.append).toHaveBeenCalledTimes(1);
  });
  it.each(["result", "rejection"])(
    "fails closed after append %s failure",
    async (kind) => {
      const f = fixture();
      await f.coordinator.execute("start");
      if (kind === "result")
        f.repositories.activities.append.mockResolvedValueOnce(
          failure("INTEGRITY_FAILURE", "private"),
        );
      else
        f.repositories.activities.append.mockRejectedValueOnce(
          new Error("private"),
        );
      expect((await f.contexts[0]!.emit([event()])).ok).toBe(false);
      await turn();
      expect(f.coordinator.getStatus().unavailable).toBe(true);
      expect(
        Object.values(f.collectors).every((collector) => !collector.running),
      ).toBe(true);
      expect((await f.contexts[0]!.emit([event(2)])).ok).toBe(false);
    },
  );
  it("validates complete batches and rejects cross-session/source spoofing", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    const context = f.contexts[0]!;
    for (const invalid of [
      { ...event(), sessionId: id(2) },
      { ...event(), source: "browser" },
      { ...event(), id: "invalid" },
    ])
      expect((await context.emit([invalid as ActivityEvent])).ok).toBe(false);
    expect(f.repositories.activities.append).not.toHaveBeenCalled();
  });
  it("suppresses excluded applications and browser titles without private-context provenance", async () => {
    const f = fixture();
    f.settings.excludedApplications = ["secret.exe"];
    await f.coordinator.execute("start");
    for (const application of ["Secret", "chrome.exe", "msedge", "Rewind.exe"])
      expect(
        (
          await f.contexts[0]!.emit([
            {
              ...event(),
              source: "windows",
              type: "foreground",
              payload: { application, windowTitle: "synthetic" },
            },
          ])
        ).ok,
      ).toBe(true);
    expect(f.repositories.activities.append).not.toHaveBeenCalled();
  });
  it("denies resource observations without engine authorization", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    expect(
      (
        await f.contexts[2]!.emit([
          {
            ...event(),
            source: "filesystem",
            type: "file-change",
            payload: { fileId: id(500), change: "updated" },
          },
        ])
      ).ok,
    ).toBe(false);
    expect(f.repositories.activities.append).not.toHaveBeenCalled();
  });
  it("bounds batch and pending work capacity", async () => {
    const f = fixture();
    await f.coordinator.execute("start");
    const context = f.contexts[0]!;
    expect(
      (await context.emit(Array.from({ length: 129 }, (_, n) => event(n)))).ok,
    ).toBe(false);
    const release = deferred();
    const entered = deferred();
    f.repositories.activities.append.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return ok();
    });
    const first = context.emit([event()]);
    await entered.promise;
    const pending = Array.from({ length: 31 }, (_, n) =>
      context.emit([event(n + 2)]),
    );
    expect((await context.emit([event(50)])).ok).toBe(false);
    const end = f.coordinator.execute("end");
    release.resolve();
    await Promise.all([first, ...pending, end]);
    expect(f.repositories.activities.append).toHaveBeenCalledTimes(1);
  });
});

describe("deadlines are failures, never cancellation acknowledgements", () => {
  it("keeps a timed-out append tracked, prevents close, and recovers only after settlement", async () => {
    vi.useFakeTimers();
    const f = fixture(true, 20);
    await f.coordinator.execute("start");
    const entered = deferred();
    const release = deferred();
    f.repositories.activities.append.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return ok();
    });
    const emission = f.contexts[0]!.emit([event()]);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(21);
    expect((await emission).ok).toBe(false);
    const shutdown = f.coordinator.shutdown();
    await vi.advanceTimersByTimeAsync(50);
    expect((await shutdown).ok).toBe(false);
    expect(f.closeStorage).not.toHaveBeenCalled();
    release.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect((await f.coordinator.shutdown()).ok).toBe(true);
    expect(f.closeStorage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops a late startup again before acknowledging shutdown", async () => {
    vi.useFakeTimers();
    const f = fixture(true, 20);
    const entered = deferred();
    const release = deferred();
    f.collectors.windows.start.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      f.collectors.windows.running = true;
      return ok();
    });
    const start = f.coordinator.execute("start");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(45);
    expect((await start).ok).toBe(false);
    const shutdown = f.coordinator.shutdown();
    await vi.advanceTimersByTimeAsync(1);
    release.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect((await shutdown).ok).toBe(true);
    expect(f.collectors.windows.running).toBe(false);
    expect(f.closeStorage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
