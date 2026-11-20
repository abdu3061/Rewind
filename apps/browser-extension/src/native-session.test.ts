import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  NativeBrowserMessage,
  NativeBrowserState,
} from "@rewind/contracts";
import type { FocusedBrowserTab } from "./metadata-controller";
import {
  ExtensionNativeSession,
  type ExtensionNativePort,
} from "./native-session";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const turn = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
const sessions: ExtensionNativeSession[] = [];
function portFixture() {
  const sent: NativeBrowserMessage[] = [],
    messages = new Set<(message: unknown) => void>(),
    disconnects = new Set<() => void>();
  const port: ExtensionNativePort = {
    postMessage: vi.fn((message) => sent.push(structuredClone(message))),
    onMessage: (listener) => {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onDisconnect: (listener) => {
      disconnects.add(listener);
      return () => disconnects.delete(listener);
    },
    disconnect: vi.fn(),
  };
  return {
    port,
    sent,
    message: (input: unknown) => {
      for (const listener of messages) listener(input);
    },
    disconnect: () => {
      for (const listener of disconnects) listener();
    },
    listeners: () => messages.size + disconnects.size,
  };
}
function fixture() {
  let nextId = 20;
  const ports: ReturnType<typeof portFixture>[] = [];
  const tab: FocusedBrowserTab = {
    id: 1,
    windowId: 1,
    active: true,
    focused: true,
    incognito: false,
    url: "https://synthetic.test/work?secret=fixture#fragment",
    title: "Synthetic page",
  };
  const read = vi.fn(
    async (authorized: () => boolean): Promise<FocusedBrowserTab | null> =>
      authorized() ? tab : null,
  );
  const connect = vi.fn(() => {
    const port = portFixture();
    ports.push(port);
    return port.port;
  });
  const session = new ExtensionNativeSession({
    profileId: id(1),
    newId: () => id(++nextId),
    connect,
    getFocusedTab: read,
    now: Date.now,
    monotonicNow: () => performance.now(),
  });
  sessions.push(session);
  const current = () => ports.at(-1)!;
  const state = (revision = 1, active = false): NativeBrowserState => {
    const connectionId = current().sent[0]!.connectionId;
    return {
      version: 2,
      type: "state",
      connectionId,
      revision,
      browser: "edge",
      authority: active
        ? {
            sessionId: id(2),
            generationId: id(3),
            capability: "a".repeat(64),
            expiresAt: new Date(Date.now() + 4000).toISOString(),
            validForMs: 4000,
            excludedSiteHosts: [],
          }
        : null,
    };
  };
  const begin = async () => {
    expect((await session.permission(true)).ok).toBe(true);
    current().message(state(1));
    await turn();
    current().message(state(2, true));
    await turn();
  };
  return { session, ports, connect, tab, read, current, state, begin };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.useRealTimers();
});

it("starts without permission, connection, timers or browser queries; hello has no self-asserted browser", async () => {
  const f = fixture();
  expect(f.session.status()).toEqual({
    permission: false,
    connected: false,
    collecting: false,
    pending: false,
    issue: null,
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect((await f.session.permission(true)).ok).toBe(true);
  expect(f.current().sent).toEqual([
    { version: 2, type: "hello", connectionId: id(21), profileId: id(1) },
  ]);
  expect(f.session.status()).toMatchObject({
    permission: true,
    connected: false,
    collecting: false,
  });
  f.current().message(f.state());
  await turn();
  expect(f.current().sent.at(-1)).toEqual({
    version: 2,
    type: "stopped",
    connectionId: id(21),
    revision: 1,
  });
  expect(f.read).not.toHaveBeenCalled();
});

it("samples only with current authority, renews without resetting sequence or poll cadence and rotates on resume", async () => {
  const f = fixture();
  await f.begin();
  expect(f.session.status()).toMatchObject({
    permission: true,
    connected: true,
    collecting: true,
  });
  const visits = () =>
    f.current().sent.filter((message) => message.type === "visit");
  expect(visits()).toEqual([
    expect.objectContaining({
      sequence: 1,
      url: "https://synthetic.test/work",
      title: "Synthetic page",
    }),
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  f.current().message(f.state(3, true));
  await turn();
  expect(f.read).toHaveBeenCalledOnce();
  f.tab.title = "Synthetic saved title";
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(visits().at(-1)).toMatchObject({
    sequence: 2,
    title: "Synthetic saved title",
  });
  f.current().message(f.state(4, false));
  await turn();
  expect(f.session.status().collecting).toBe(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.read).toHaveBeenCalledTimes(2);
  const resumed = f.state(5, true);
  if (!resumed.authority) throw new Error("SYNTHETIC_LEASE_MISSING");
  resumed.authority.generationId = id(4);
  resumed.authority.capability = "b".repeat(64);
  f.current().message(resumed);
  await turn();
  expect(visits().at(-1)).toMatchObject({ generationId: id(4), sequence: 1 });
});

it("invalidates queries immediately on off and acknowledges only after the pending query drains", async () => {
  const f = fixture();
  let resolve!: (value: FocusedBrowserTab | null) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.begin();
  expect(f.session.status().pending).toBe(true);
  f.current().message(f.state(3));
  await turn();
  expect(f.session.status().collecting).toBe(false);
  expect(
    f
      .current()
      .sent.some(
        (message) => message.type === "stopped" && message.revision === 3,
      ),
  ).toBe(false);
  const inspected: PropertyKey[] = [];
  resolve(
    new Proxy(f.tab, {
      get(target, key, receiver) {
        if (key !== "then") inspected.push(key);
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  await turn();
  expect(inspected).toEqual([]);
  expect(f.current().sent.at(-1)).toEqual({
    version: 2,
    type: "stopped",
    connectionId: id(21),
    revision: 3,
  });
  expect(f.current().sent.some((message) => message.type === "visit")).toBe(
    false,
  );
});

it("local disable drains pending work and sends a current stop ack without dropping the passive port", async () => {
  const f = fixture();
  let resolve!: (value: FocusedBrowserTab | null) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.begin();
  let finished = false;
  const disabled = f.session.permission(false).then((result) => {
    finished = true;
    return result;
  });
  expect(f.session.status()).toMatchObject({
    permission: false,
    collecting: false,
    pending: true,
  });
  await turn();
  expect(finished).toBe(false);
  resolve(f.tab);
  expect((await disabled).ok).toBe(true);
  expect(f.current().sent.at(-1)).toEqual({
    version: 2,
    type: "stopped",
    connectionId: id(21),
    revision: 2,
  });
  expect(f.current().port.disconnect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.read).toHaveBeenCalledOnce();
});

it("revokes on lost native connection, starts no automatic retry and waits for pending work before an explicit new connection", async () => {
  const f = fixture();
  let resolve!: (value: FocusedBrowserTab | null) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.begin();
  const old = f.current();
  old.disconnect();
  expect(f.session.status()).toMatchObject({
    permission: false,
    connected: false,
    collecting: false,
    pending: true,
    issue: "connection",
  });
  expect(old.listeners()).toBe(0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.connect).toHaveBeenCalledOnce();
  const reconnecting = f.session.permission(true);
  await turn();
  expect(f.connect).toHaveBeenCalledOnce();
  resolve(f.tab);
  expect((await reconnecting).ok).toBe(true);
  expect(f.connect).toHaveBeenCalledTimes(2);
  expect(f.current().sent[0]).toMatchObject({
    type: "hello",
    connectionId: id(22),
  });
  expect(f.session.status().collecting).toBe(false);
  expect(f.read).toHaveBeenCalledOnce();
});

it.each([{ connectionId: id(99) }, { browser: "chrome" }, { expanded: true }])(
  "revokes on expanded or mismatched native authority: %j",
  async (change) => {
    const f = fixture();
    await f.begin();
    const port = f.current();
    port.message({ ...f.state(3, true), ...change });
    await turn();
    expect(f.session.status()).toMatchObject({
      permission: false,
      connected: false,
      collecting: false,
      issue: "protocol",
    });
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.read).toHaveBeenCalledOnce();
  },
);

it("ignores stale authority and fences old-port callbacks after a new explicit approval", async () => {
  const f = fixture();
  await f.begin();
  const old = f.current(),
    stale = f.state(1, false);
  old.message(stale);
  await turn();
  expect(f.session.status().collecting).toBe(true);
  expect((await f.session.permission(false)).ok).toBe(true);
  expect((await f.session.permission(true)).ok).toBe(true);
  expect(f.current()).not.toBe(old);
  old.message(f.state(50, true));
  old.disconnect();
  await turn();
  expect(f.session.status()).toMatchObject({
    permission: true,
    connected: false,
    collecting: false,
    issue: null,
  });
  expect(f.read).toHaveBeenCalledOnce();
});

it("reports missing host, missing ready authority and failed sends without querying or pretending data was saved", async () => {
  const f = fixture();
  f.connect.mockImplementationOnce(() => {
    throw new Error("Synthetic host missing");
  });
  expect((await f.session.permission(true)).ok).toBe(false);
  expect(f.session.status()).toMatchObject({
    permission: false,
    connected: false,
    issue: "connection",
  });
  expect((await f.session.permission(true)).ok).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.session.status()).toMatchObject({
    permission: false,
    connected: false,
    issue: "connection",
  });
  expect(f.read).not.toHaveBeenCalled();
  const g = fixture();
  await g.begin();
  vi.mocked(g.current().port.postMessage).mockImplementationOnce(() => {
    throw new Error("Synthetic failed send");
  });
  g.tab.title = "Synthetic new title";
  await vi.advanceTimersByTimeAsync(2000);
  await turn();
  expect(g.session.status()).toMatchObject({
    permission: false,
    connected: false,
    collecting: false,
    issue: "send",
  });
  expect(
    g.current().sent.filter((message) => message.type === "visit"),
  ).toHaveLength(1);
});

it("expires current authority on the polling timer and requires fresh explicit approval", async () => {
  const f = fixture();
  await f.begin();
  await vi.advanceTimersByTimeAsync(4000);
  await turn();
  expect(f.session.status()).toMatchObject({
    permission: false,
    connected: false,
    collecting: false,
    issue: "protocol",
  });
  const count = f.read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.read).toHaveBeenCalledTimes(count);
  expect(f.connect).toHaveBeenCalledOnce();
});

it("coalesces close and never acknowledges local shutdown before a pending query drains", async () => {
  const f = fixture();
  let resolve!: (value: FocusedBrowserTab | null) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.begin();
  let finished = false;
  const closing = f.session.close();
  expect(f.session.close()).toBe(closing);
  void closing.then(() => {
    finished = true;
  });
  await turn();
  expect(finished).toBe(false);
  expect((await f.session.permission(true)).ok).toBe(false);
  resolve(f.tab);
  await closing;
  expect(f.current().port.disconnect).toHaveBeenCalledOnce();
  expect(f.current().listeners()).toBe(0);
  expect(f.session.status()).toMatchObject({
    permission: false,
    connected: false,
    collecting: false,
    pending: false,
  });
});

it("rejects invalid profile identity and superseded approval without starting another connection", async () => {
  expect(
    () =>
      new ExtensionNativeSession({
        profileId: "invalid",
        connect: () => portFixture().port,
        getFocusedTab: async () => null,
      }),
  ).toThrow("BROWSER_PROFILE_ID_INVALID");
  const f = fixture();
  await f.begin();
  expect((await f.session.permission(false)).ok).toBe(true);
  const enabling = f.session.permission(true);
  const disabling = f.session.permission(false);
  expect((await enabling).ok).toBe(false);
  expect((await disabling).ok).toBe(true);
  expect(f.connect).toHaveBeenCalledOnce();
});
