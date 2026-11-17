import { expect, it, vi } from "vitest";
import {
  browserSiteHostSchema,
  type NativeBrowserMessage,
  type NativeBrowserState,
} from "@rewind/contracts";
import {
  BrowserMetadataController,
  type FocusedBrowserTab,
} from "./metadata-controller";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let now = Date.parse("2026-11-17T10:00:00.000Z"),
    ticks = 0;
  const tab: FocusedBrowserTab = {
    id: 1,
    windowId: 1,
    active: true,
    focused: true,
    incognito: false,
    url: "https://example.test/work?token=secret#private",
    title: "Synthetic page",
  };
  const read = vi.fn(
    async (authorized: () => boolean): Promise<FocusedBrowserTab | null> =>
      authorized() ? tab : null,
  );
  const sent: NativeBrowserMessage[] = [],
    unavailable = vi.fn();
  const send = vi.fn((message: NativeBrowserMessage) => {
    sent.push(structuredClone(message));
  });
  const controller = new BrowserMetadataController({
    connectionId: id(1),
    browser: "chrome",
    now: () => now,
    monotonicNow: () => ticks,
    getFocusedTab: read,
    send,
    unavailable,
  });
  const state = (revision = 1): NativeBrowserState => ({
    version: 2,
    type: "state",
    connectionId: id(1),
    revision,
    browser: "chrome",
    authority: {
      sessionId: id(2),
      generationId: id(3),
      capability: "a".repeat(64),
      expiresAt: new Date(now + 3000).toISOString(),
      validForMs: 3000,
      excludedSiteHosts: [],
    },
  });
  return {
    controller,
    tab,
    read,
    sent,
    send,
    unavailable,
    state,
    advance: (wall: number, mono = wall) => {
      now += wall;
      ticks += mono;
    },
  };
}
it("reads no browser metadata without both extension approval and current desktop authority", async () => {
  const f = fixture();
  await f.controller.sample();
  expect(f.read).not.toHaveBeenCalled();
  expect(await f.controller.state(f.state())).toEqual({
    ok: true,
    value: "stopped",
  });
  await f.controller.permission(true);
  await f.controller.sample();
  expect(f.read).not.toHaveBeenCalled();
  await f.controller.state(f.state(2));
  await f.controller.sample();
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.sent.at(-1)).toMatchObject({
    type: "visit",
    url: "https://example.test/work",
    incognito: false,
    focused: true,
    sequence: 1,
    capability: "a".repeat(64),
  });
  await f.controller.permission(false);
  await f.controller.sample();
  expect(f.read).toHaveBeenCalledOnce();
});
it("redacts queries/fragments, deduplicates repeated views and keeps sequence across lease renewal", async () => {
  const f = fixture();
  await f.controller.permission(true);
  await f.controller.state(f.state());
  await f.controller.sample();
  await f.controller.sample();
  expect(f.sent).toHaveLength(1);
  f.advance(1000);
  await f.controller.state(f.state(2));
  f.tab.title = "Updated synthetic title";
  await f.controller.sample();
  f.tab.id = 2;
  await f.controller.sample();
  expect(
    f.sent.map((message) => (message.type === "visit" ? message.sequence : 0)),
  ).toEqual([1, 2, 3]);
  expect(
    f.sent.every(
      (message) =>
        message.type === "visit" && message.url === "https://example.test/work",
    ),
  ).toBe(true);
});
it("checks private/inactive/unfocused context and website exclusions before reading titles", async () => {
  for (const context of [
    { incognito: true },
    { active: false },
    { focused: false },
    { id: -1 },
  ]) {
    const f = fixture(),
      url = vi.fn(() => "https://private.test/"),
      title = vi.fn(() => "Must not inspect");
    Object.assign(f.tab, context);
    Object.defineProperty(f.tab, "url", { get: url });
    Object.defineProperty(f.tab, "title", { get: title });
    await f.controller.permission(true);
    await f.controller.state(f.state());
    await f.controller.sample();
    expect(url).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  }
  const f = fixture(),
    title = vi.fn(() => "Excluded title");
  f.tab.url = "https://sub.private.test/work?secret=value";
  Object.defineProperty(f.tab, "title", { get: title });
  const state = f.state();
  state.authority!.excludedSiteHosts = ["private.test"];
  await f.controller.permission(true);
  await f.controller.state(state);
  await f.controller.sample();
  expect(title).not.toHaveBeenCalled();
  expect(f.sent).toHaveLength(0);
});
it("invalidates a pending query immediately and acknowledges stop only after it drains without inspecting its result", async () => {
  const f = fixture(),
    pending = deferred<FocusedBrowserTab | null>(),
    fields = vi.fn();
  let authorized!: () => boolean;
  f.read.mockImplementationOnce((check) => {
    authorized = check;
    return pending.promise;
  });
  await f.controller.permission(true);
  await f.controller.state(f.state());
  const sampling = f.controller.sample();
  expect(authorized()).toBe(true);
  let stopped = false;
  const stopping = f.controller
    .state({ ...f.state(2), authority: null })
    .then((result) => {
      stopped = true;
      return result;
    });
  expect(authorized()).toBe(false);
  expect(stopped).toBe(false);
  pending.resolve(
    new Proxy({} as FocusedBrowserTab, {
      get: (_target, key) => {
        if (key !== "then") fields(key); // Promise resolution probes thenables; no browser metadata is inspected.
        return undefined;
      },
    }),
  );
  await sampling;
  expect(await stopping).toEqual({ ok: true, value: "stopped" });
  expect(fields).not.toHaveBeenCalled();
  expect(f.sent).toEqual([
    { version: 2, type: "stopped", connectionId: id(1), revision: 2 },
  ]);
});
it("collapses a burst to one pending query plus one follow-up and discards an old generation", async () => {
  const f = fixture(),
    pending = deferred<FocusedBrowserTab | null>(),
    fields = vi.fn();
  f.read.mockImplementationOnce(() => pending.promise);
  await f.controller.permission(true);
  await f.controller.state(f.state());
  const sampling = f.controller.sample();
  for (let i = 0; i < 20; i++) void f.controller.sample();
  expect(f.read).toHaveBeenCalledOnce();
  const next = f.state(2);
  next.authority = {
    ...next.authority!,
    capability: "b".repeat(64),
    generationId: id(4),
  };
  await f.controller.state(next);
  void f.controller.sample();
  pending.resolve(
    new Proxy({} as FocusedBrowserTab, {
      get: (_target, key) => {
        if (key !== "then") fields(key);
        return undefined;
      },
    }),
  );
  await sampling;
  await f.controller.drain();
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(fields).not.toHaveBeenCalled();
  expect(f.sent).toMatchObject([
    {
      type: "visit",
      generationId: id(4),
      capability: "b".repeat(64),
      sequence: 1,
    },
  ]);
  expect(await f.controller.state(f.state(1))).toEqual({
    ok: true,
    value: "ignored",
  });
});
it("expires on monotonic time and cannot revive a closed native connection", async () => {
  const f = fixture();
  await f.controller.permission(true);
  await f.controller.state(f.state());
  f.advance(0, 4000);
  await f.controller.sample();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.unavailable).toHaveBeenCalledOnce();
  expect((await f.controller.state(f.state(2))).ok).toBe(false);
});
it("fails closed on expanded/wrong/overlong authority or a failed send and allows transient query failures without inventing data", async () => {
  for (const change of [
    { connectionId: id(8) },
    { browser: "edge" },
    { expanded: true },
  ]) {
    const f = fixture();
    await f.controller.permission(true);
    expect((await f.controller.state({ ...f.state(), ...change })).ok).toBe(
      false,
    );
    await f.controller.sample();
    expect(f.read).not.toHaveBeenCalled();
  }
  const f = fixture();
  await f.controller.permission(true);
  await f.controller.state(f.state());
  f.read.mockRejectedValueOnce(new Error("Synthetic unavailable tab"));
  await f.controller.sample();
  expect(f.sent).toHaveLength(0);
  f.send.mockImplementationOnce(() => {
    throw new Error("Synthetic disconnected port");
  });
  await f.controller.sample();
  expect(f.controller.status().closed).toBe(true);
  expect(f.unavailable).toHaveBeenCalledOnce();
});
it("normalizes literal site exclusions and rejects wildcard/path/credential/port entries", () => {
  expect(browserSiteHostSchema.parse(" Example.TEST. ")).toBe("example.test");
  expect(browserSiteHostSchema.parse("[::1]")).toBe("[::1]");
  for (const host of [
    "*",
    "https://example.test",
    "example.test/path",
    "user:pass@example.test",
    "example.test:443",
    "bad..test",
  ])
    expect(browserSiteHostSchema.safeParse(host).success).toBe(false);
});
