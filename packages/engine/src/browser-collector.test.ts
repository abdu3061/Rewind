import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  failure,
  type ActivityEvent,
  type BrowserPeer,
  type BrowserTransportListener,
  type CollectorContext,
  type NativeBrowserMessage,
  type NativeBrowserState,
  type Result,
} from "@rewind/contracts";
import { BrowserCollector } from "./browser-collector";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cap = "a".repeat(64);
const ok = (): Result<void> => ({ ok: true, value: undefined });
const turn = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
const fixtures: {
  source: BrowserCollector;
  listener: BrowserTransportListener;
  states: { id: string; state: NativeBrowserState }[];
  acknowledge: (value: boolean) => void;
}[] = [];
function fixture() {
  let listener!: BrowserTransportListener;
  const states: { id: string; state: NativeBrowserState }[] = [];
  let authorized = false;
  let sequence = 100;
  let capability = 0;
  let acknowledge = true;
  const events: ActivityEvent[] = [];
  const transport = {
    setListener: (value: BrowserTransportListener) => {
      listener = value;
    },
    send: vi.fn((peerId: string, state: NativeBrowserState): Result<void> => {
      states.push({ id: peerId, state: structuredClone(state) });
      if (!state.authority && acknowledge)
        queueMicrotask(() =>
          listener.message(peerId, {
            version: 2,
            type: "stopped",
            connectionId: state.connectionId,
            revision: state.revision,
          }),
        );
      return ok();
    }),
    disconnect: vi.fn(),
  };
  const source = new BrowserCollector({
    transport,
    now: Date.now,
    monotonicNow: () => performance.now(),
    newId: () => id(++sequence),
    newCapability: () => String(++capability).repeat(64),
  });
  const context: CollectorContext = {
    sessionId: id(1),
    generationId: id(2),
    settings: { ...createDefaultSettings(), browserCollectionConsent: true },
    authorized: () => authorized,
    reportUnavailable: vi.fn(),
    emit: vi.fn(async (batch) => {
      for (const event of batch) {
        if (event.type === "browser-visit") {
          const checked = source.authorize(event, context.settings);
          if (!checked.ok) return checked;
        }
      }
      events.push(...structuredClone(batch));
      return ok();
    }),
  };
  const peer: BrowserPeer = {
    id: id(10),
    origin: `chrome-extension://${"b".repeat(32)}/`,
    browser: "edge",
  };
  const hello = (proof = peer, connectionId = id(20)) => {
    listener.connected(proof);
    listener.message(proof.id, {
      version: 2,
      type: "hello",
      connectionId,
      profileId: id(30),
    });
  };
  const lease = () =>
    states.filter(({ state }) => state.authority).at(-1)!.state;
  const visit = (
    override: Partial<Extract<NativeBrowserMessage, { type: "visit" }>> = {},
    peerId = peer.id,
  ) => {
    const state = lease(),
      authority = state.authority!;
    listener.message(peerId, {
      version: 2,
      type: "visit",
      connectionId: state.connectionId,
      sessionId: authority.sessionId,
      generationId: authority.generationId,
      capability: authority.capability,
      sequence: 1,
      occurredAt: "2020-01-01T00:00:00.000Z",
      incognito: false,
      focused: true,
      url: "https://example.test/page",
      title: "Synthetic browser page",
      ...override,
    });
  };
  const begin = async () => {
    hello();
    expect((await source.start(context)).ok).toBe(true);
    authorized = true;
    await vi.advanceTimersByTimeAsync(0);
  };
  const f = {
    source,
    listener,
    transport,
    context,
    states,
    events,
    peer,
    hello,
    lease,
    visit,
    begin,
    approve: (value: boolean) => {
      authorized = value;
    },
    acknowledge: (value: boolean) => {
      acknowledge = value;
    },
  };
  fixtures.push(f);
  return f;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.acknowledge(true);
    for (const { id: peerId, state } of f.states)
      if (!state.authority)
        f.listener.message(peerId, {
          version: 2,
          type: "stopped",
          connectionId: state.connectionId,
          revision: state.revision,
        });
    await f.source.stop();
  }
  vi.useRealTimers();
});

it("requires separate approval/current engine authority and issues no lease before lifecycle commit", async () => {
  const f = fixture();
  f.hello();
  f.context.settings = {
    ...f.context.settings,
    browserCollectionConsent: false,
  };
  expect((await f.source.start(f.context)).ok).toBe(false);
  f.context.settings = {
    ...f.context.settings,
    browserCollectionConsent: true,
  };
  const missingPredicate = { ...f.context };
  delete missingPredicate.authorized;
  expect((await f.source.start(missingPredicate)).ok).toBe(false);
  expect((await f.source.start(f.context)).ok).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.states.every(({ state }) => state.authority === null)).toBe(true);
  f.approve(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.lease().authority).toMatchObject({
    sessionId: id(1),
    generationId: id(2),
  });
  expect(f.events).toEqual([]);
});

it("persists only real staged metadata, uses native-proven browser and receipt time, and counts confirmed writes", async () => {
  const f = fixture();
  await f.begin();
  f.visit();
  expect(f.source.status().captured).toBe(0);
  await turn();
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({
    sessionId: id(1),
    occurredAt: "2026-11-17T12:00:00.000Z",
    type: "browser-visit",
    payload: {
      browser: "edge",
      url: "https://example.test/page",
      visitedAt: "2026-11-17T12:00:00.000Z",
      endedAt: null,
    },
  });
  expect(f.source.status().captured).toBe(1);
  expect(f.source.authorize(f.events[0]!, f.context.settings).ok).toBe(false);
});

it("rechecks exact staged evidence and current permission while a write is pending", async () => {
  const f = fixture();
  await f.begin();
  let resolve!: (result: Result<void>) => void;
  let staged!: ActivityEvent;
  vi.mocked(f.context.emit).mockImplementationOnce(async (events) => {
    staged = structuredClone(events[0]!);
    return new Promise((done) => {
      resolve = done;
    });
  });
  f.visit();
  await turn();
  expect(f.source.authorize(staged, f.context.settings).ok).toBe(true);
  const changed = structuredClone(staged);
  if (changed.type === "browser-visit") changed.payload.title = "Forged";
  expect(f.source.authorize(changed, f.context.settings).ok).toBe(false);
  expect(
    f.source.authorize(staged, {
      ...f.context.settings,
      browserCollectionConsent: false,
    }).ok,
  ).toBe(false);
  f.approve(false);
  expect(f.source.authorize(staged, f.context.settings).ok).toBe(false);
  resolve(failure("FORBIDDEN", "Revoked."));
  await turn();
  expect(f.source.status().captured).toBe(0);
});

it("canonicalizes exclusions, denies subdomains and does not ingest internal or private metadata", async () => {
  const f = fixture();
  f.context.settings = {
    ...f.context.settings,
    excludedSiteHosts: ["BLOCKED.test."],
  };
  await f.begin();
  expect(f.lease().authority!.excludedSiteHosts).toEqual(["blocked.test"]);
  f.visit({ url: "https://sub.blocked.test/page" });
  await turn();
  expect(f.events).toEqual([]);
  // Expanded protocol fields/private/internal URLs are invalid, rather than an extraction permission.
  f.visit({ sequence: 2, incognito: true as false });
  await turn();
  expect(f.events.every((event) => event.type === "capture-gap")).toBe(true);
  expect(f.transport.disconnect).toHaveBeenCalledWith(f.peer.id);
});

it.each([
  { sequence: 1 },
  { capability: cap },
  { sessionId: id(99) },
  { generationId: id(99) },
  { connectionId: id(99) },
])(
  "rejects replay or mismatched native connection/run capability: %j",
  async (bad) => {
    const f = fixture();
    await f.begin();
    f.visit();
    await turn();
    f.visit(bad);
    await turn();
    expect(
      f.events.filter((event) => event.type === "browser-visit"),
    ).toHaveLength(1);
    expect(f.transport.disconnect).toHaveBeenCalledWith(f.peer.id);
    expect(f.source.status().state).toBe("unavailable");
    expect(f.context.reportUnavailable).toHaveBeenCalledOnce();
  },
);

it("renews one capability without resetting sequence, then rotates authority on resume", async () => {
  const f = fixture();
  await f.begin();
  const first = f.lease();
  f.visit();
  await turn();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.lease().revision).toBeGreaterThan(first.revision);
  expect(f.lease().authority!.capability).toBe(first.authority!.capability);
  f.visit({ sequence: 2 });
  await turn();
  expect((await f.source.pause()).ok).toBe(true);
  f.context.generationId = id(3);
  expect((await f.source.resume(f.context)).ok).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.lease().authority!.capability).not.toBe(first.authority!.capability);
  expect(f.lease().authority!.generationId).toBe(id(3));
  f.visit();
  await turn();
  expect(f.source.status().captured).toBe(1);
});

it("invalidates immediately on pause, waits for the matching stop ack AND pending persistence, and ignores stale ack/visits", async () => {
  const f = fixture();
  await f.begin();
  let resolve!: (result: Result<void>) => void;
  vi.mocked(f.context.emit).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.visit();
  await turn();
  f.acknowledge(false);
  let finished = false;
  const stopping = f.source.pause().then((result) => {
    finished = true;
    return result;
  });
  const off = f.states.at(-1)!.state;
  expect(off.authority).toBeNull();
  f.visit({ sequence: 2 });
  f.listener.message(f.peer.id, {
    version: 2,
    type: "stopped",
    connectionId: id(20),
    revision: off.revision - 1,
  });
  await turn();
  expect(finished).toBe(false);
  f.listener.message(f.peer.id, {
    version: 2,
    type: "stopped",
    connectionId: id(20),
    revision: off.revision,
  });
  await turn();
  expect(finished).toBe(false);
  resolve(failure("FORBIDDEN", "Permission changed."));
  expect((await stopping).ok).toBe(true);
  expect(f.context.emit).toHaveBeenCalledOnce();
  expect(f.source.status().captured).toBe(0);
});

it("reports uncertainty when stop acknowledgement is lost; disconnect is never fabricated as a stop ack", async () => {
  const f = fixture();
  await f.begin();
  f.acknowledge(false);
  const stopping = f.source.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect((await stopping).ok).toBe(false);
  expect(f.transport.disconnect).toHaveBeenCalledWith(f.peer.id);
  expect((await f.source.resume(f.context)).ok).toBe(false);
  expect(f.source.status().state).toBe("unavailable");
});

it("records a real gap on unexpected disconnect and requires fresh service approval instead of resuming silently", async () => {
  const f = fixture();
  await f.begin();
  f.listener.disconnected(f.peer.id);
  await turn();
  expect(f.events).toEqual([
    expect.objectContaining({
      type: "capture-gap",
      source: "browser",
      payload: { collectorId: "browser", reason: "unavailable" },
    }),
  ]);
  expect(f.context.reportUnavailable).toHaveBeenCalledOnce();
  expect((await f.source.stop()).ok).toBe(false);
});

it("drops unauthenticated/unknown channels, enforces four peers, and rejects a second hello", async () => {
  const f = fixture();
  f.listener.message(id(999), {
    version: 2,
    type: "hello",
    connectionId: id(998),
    profileId: id(997),
  });
  expect(f.states).toEqual([]);
  for (let n = 0; n < 5; n++)
    f.hello({ ...f.peer, id: id(10 + n) }, id(20 + n));
  expect(f.source.status().connected).toBe(4);
  expect(f.transport.disconnect).toHaveBeenCalledWith(id(14));
  f.listener.message(f.peer.id, {
    version: 2,
    type: "hello",
    connectionId: id(88),
    profileId: id(89),
  });
  expect(f.transport.disconnect).toHaveBeenCalledWith(f.peer.id);
});

it("fences a late start after concurrent stop and rejects invalid exclusion policies", async () => {
  const f = fixture();
  const starting = f.source.start(f.context);
  const stopping = f.source.stop();
  expect((await starting).ok).toBe(false);
  expect((await stopping).ok).toBe(true);
  f.context.settings = {
    ...f.context.settings,
    excludedSiteHosts: ["example.test/path"],
  };
  expect((await f.source.start(f.context)).ok).toBe(false);
  f.context.settings = {
    ...f.context.settings,
    excludedSiteHosts: Array<string>(201).fill("example.test"),
  };
  expect((await f.source.start(f.context)).ok).toBe(false);
  expect(f.source.status().state).toBe("off");
});

it("bounds pending observations and never counts a failed persistence as saved", async () => {
  const f = fixture();
  await f.begin();
  const resolvers: ((result: Result<void>) => void)[] = [];
  vi.mocked(f.context.emit).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );
  for (let n = 1; n <= 32; n++) {
    f.visit({ sequence: n });
    await turn();
  }
  f.visit({ sequence: 33 });
  await turn();
  expect(resolvers).toHaveLength(33); // 32 observations plus one bounded failure/gap control operation.
  expect(f.source.status().state).toBe("unavailable");
  expect(f.states.at(-1)!.state.authority).toBeNull();
  for (const resolve of resolvers)
    resolve(failure("UNAVAILABLE", "Fixture write failed."));
  await turn();
  expect(f.source.status().pending).toBe(0);
  expect(f.source.status().captured).toBe(0);
  expect(f.context.reportUnavailable).toHaveBeenCalledOnce();
});

it("expires authority on monotonic time even if the wall clock moves backwards", async () => {
  const f = fixture();
  await f.begin();
  vi.spyOn(performance, "now").mockReturnValue(performance.now() + 5000);
  vi.setSystemTime(new Date("2026-11-17T11:00:00.000Z"));
  f.visit();
  await turn();
  expect(f.events.every((event) => event.type === "capture-gap")).toBe(true);
  expect(f.transport.disconnect).toHaveBeenCalledWith(f.peer.id);
});

it("honors client permission denial only at the current revision, with a real gap and no automatic renewal", async () => {
  const f = fixture();
  await f.begin();
  const granted = f.lease();
  f.listener.message(f.peer.id, {
    version: 2,
    type: "stopped",
    connectionId: id(20),
    revision: granted.revision - 1,
  });
  expect(f.source.status().state).toBe("active");
  f.listener.message(f.peer.id, {
    version: 2,
    type: "stopped",
    connectionId: id(20),
    revision: granted.revision,
  });
  await turn();
  expect(f.events).toEqual([
    expect.objectContaining({
      type: "capture-gap",
      payload: { collectorId: "browser", reason: "permission-denied" },
    }),
  ]);
  const count = f.states.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.states).toHaveLength(count);
  expect((await f.source.stop()).ok).toBe(true); // Actual drained acknowledgement, unlike a lost connection.
});

it("drops an admitted observation before its asynchronous emit starts when stop invalidates it", async () => {
  const f = fixture();
  await f.begin();
  f.visit();
  expect((await f.source.stop()).ok).toBe(true);
  expect(f.context.emit).not.toHaveBeenCalled();
  expect(f.source.status().pending).toBe(0);
});
