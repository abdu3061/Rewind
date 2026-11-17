import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  failure,
  type CollectorContext,
  type Result,
} from "@rewind/contracts";
import { WindowsCollector } from "./windows-collector";
import type { ActiveWindowInfo } from "./types";
const now = "2026-11-16T10:00:00.000Z";
const ok = async (): Promise<Result<void>> => ({ ok: true, value: undefined });
const collectors: WindowsCollector[] = [];
function context(consent = true): CollectorContext {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    generationId: "00000000-0000-4000-8000-000000000002",
    settings: { ...createDefaultSettings(), collectionConsent: consent },
    emit: vi.fn(ok),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const query = vi.fn(async (): Promise<ActiveWindowInfo | null> => ({
    application: "Code.exe",
    windowTitle: "Synthetic",
  }));
  const close = vi.fn(async () => {});
  const collector = new WindowsCollector({
    strategy: { getActiveWindow: query, close },
    pollIntervalMs: 60000,
    now: () => now,
    newId: () => "00000000-0000-4000-8000-000000000003",
  });
  collectors.push(collector);
  return { collector, query, close };
}
afterEach(async () => {
  for (const collector of collectors.splice(0)) await collector.stop();
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
it("rejects missing consent without querying or starting a timer", async () => {
  const f = fixture();
  expect((await f.collector.start(context(false))).ok).toBe(false);
  expect(f.query).not.toHaveBeenCalled();
});
it("waits for helper release and surfaces a failed close rather than acknowledging stop", async () => {
  const f = fixture();
  await f.collector.start(context());
  const release = deferred<void>();
  f.close.mockImplementationOnce(() => release.promise);
  let done = false;
  const stopping = f.collector.stop().then((result) => {
    done = true;
    return result;
  });
  await turn();
  expect(done).toBe(false);
  release.resolve();
  expect((await stopping).ok).toBe(true);
  f.close.mockRejectedValueOnce(new Error("Synthetic helper failure"));
  expect((await f.collector.stop()).ok).toBe(false);
});
it("reports startup query failure instead of pretending successful capture", async () => {
  const f = fixture();
  f.query.mockRejectedValue(new Error("Synthetic private text"));
  expect(await f.collector.start(context())).toMatchObject({ ok: false });
});
it("waits for an in-flight native query and rejects its late result after stop", async () => {
  const f = fixture();
  const c = context();
  await f.collector.start(c);
  await turn();
  const pending = deferred<ActiveWindowInfo | null>();
  f.query.mockImplementationOnce(() => pending.promise);
  const poll = f.collector.poll();
  await turn();
  let stopped = false;
  const stop = f.collector.stop().then(() => {
    stopped = true;
  });
  await turn();
  const wasStopped = stopped;
  pending.resolve({ application: "Other.exe", windowTitle: "Synthetic late" });
  await Promise.all([poll, stop]);
  expect(wasStopped).toBe(false);
  expect(
    vi
      .mocked(c.emit)
      .mock.calls.flatMap(([events]) => events)
      .some(
        (event) =>
          event.type === "foreground" &&
          event.payload.windowTitle === "Synthetic late",
      ),
  ).toBe(false);
});
it("does not deduplicate an observation rejected by ingestion", async () => {
  const f = fixture();
  const c = context();
  vi.mocked(c.emit).mockResolvedValueOnce(failure("UNAVAILABLE", "Synthetic"));
  await f.collector.start(c);
  await turn();
  await f.collector.poll();
  await f.collector.poll();
  expect(
    vi
      .mocked(c.emit)
      .mock.calls.filter(([events]) =>
        events.some((event) => event.type === "foreground"),
      ).length,
  ).toBeGreaterThanOrEqual(2);
});
it("waits for a pending emit before pause acknowledgement", async () => {
  const f = fixture();
  const c = context();
  await f.collector.start(c);
  const pending = deferred<Result<void>>();
  vi.mocked(c.emit).mockImplementationOnce(() => pending.promise);
  const poll = f.collector.poll();
  await turn();
  let stopped = false;
  const pause = f.collector.pause().then(() => {
    stopped = true;
  });
  await turn();
  const early = stopped;
  pending.resolve({ ok: true, value: undefined });
  await Promise.all([poll, pause]);
  expect(early).toBe(false);
  expect((await f.collector.poll()).ok).toBe(false);
});
it("does not activate after stop overtakes an asynchronous startup query", async () => {
  const f = fixture();
  const pending = deferred<ActiveWindowInfo | null>();
  f.query.mockImplementationOnce(() => pending.promise);
  const start = f.collector.start(context());
  await turn();
  const stop = f.collector.stop();
  pending.resolve(null);
  expect((await start).ok).toBe(false);
  expect((await stop).ok).toBe(true);
  expect((await f.collector.poll()).ok).toBe(false);
});
it("reports a capture gap on runtime query failure without sensitive diagnostics", async () => {
  const f = fixture();
  const c = context();
  await f.collector.start(c);
  f.query.mockRejectedValueOnce(new Error("Synthetic private title/path"));
  const warn = vi.spyOn(console, "warn");
  expect(await f.collector.poll()).toMatchObject({
    ok: false,
    error: { message: "Window query is unavailable." },
  });
  expect(c.emit).toHaveBeenCalledWith([
    expect.objectContaining({ type: "capture-gap" }),
  ]);
  expect(warn).not.toHaveBeenCalled();
});
