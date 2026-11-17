import { expect, it, vi } from "vitest";
import {
  focusedBrowserTab,
  type BrowserMetadataAccess,
  type BrowserTabMetadata,
  type BrowserWindowMetadata,
} from "./focused-tab-provider";
import { BrowserMetadataController } from "./metadata-controller";
import type { NativeBrowserMessage } from "@rewind/contracts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let authorized = true;
  const window: BrowserWindowMetadata = {
    id: 1,
    focused: true,
    incognito: false,
    type: "normal",
  };
  const tab: BrowserTabMetadata = {
    id: 2,
    windowId: 1,
    active: true,
    incognito: false,
    url: "https://synthetic.test/work?secret=fixture#fragment",
    title: "Synthetic page",
  };
  const access = {
    lastFocusedWindow: vi.fn(async () => window),
    activeTabs: vi.fn(async () => [tab]),
    window: vi.fn(async () => ({ ...window })),
  } satisfies BrowserMetadataAccess;
  return {
    access,
    window,
    tab,
    authorized: () => authorized,
    revoke: () => {
      authorized = false;
    },
  };
}

it("calls no browser API without authority, including a failed authorization predicate", async () => {
  const f = fixture();
  f.revoke();
  expect(await focusedBrowserTab(f.access, f.authorized)).toBeNull();
  expect(
    await focusedBrowserTab(f.access, () => {
      throw new Error("Synthetic unavailable authority");
    }),
  ).toBeNull();
  expect(f.access.lastFocusedWindow).not.toHaveBeenCalled();
  expect(f.access.activeTabs).not.toHaveBeenCalled();
  expect(f.access.window).not.toHaveBeenCalled();
});

it.each([
  { incognito: true },
  { focused: false },
  { type: "popup" },
  { id: -1 },
  { id: undefined },
])(
  "rejects private/unfocused/unsupported windows before any tab query: %j",
  async (change) => {
    const f = fixture();
    Object.assign(f.window, change);
    expect(await focusedBrowserTab(f.access, f.authorized)).toBeNull();
    expect(f.access.activeTabs).not.toHaveBeenCalled();
  },
);

it("rechecks authority after a pending window query before inspecting any fields or starting a tab query", async () => {
  const f = fixture(),
    pending = deferred<BrowserWindowMetadata>();
  f.access.lastFocusedWindow.mockReturnValueOnce(pending.promise);
  const reading = focusedBrowserTab(f.access, f.authorized);
  f.revoke();
  const fields: PropertyKey[] = [];
  pending.resolve(
    new Proxy(f.window, {
      get(target, key, receiver) {
        if (key !== "then") fields.push(key);
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  expect(await reading).toBeNull();
  expect(fields).toEqual([]);
  expect(f.access.activeTabs).not.toHaveBeenCalled();
});

it("discards revoked tab results without inspecting them or starting the focus recheck", async () => {
  const f = fixture(),
    pending = deferred<BrowserTabMetadata[]>();
  f.access.activeTabs.mockReturnValueOnce(pending.promise);
  const reading = focusedBrowserTab(f.access, f.authorized);
  await Promise.resolve();
  expect(f.access.activeTabs).toHaveBeenCalledWith(1);
  f.revoke();
  const fields: PropertyKey[] = [];
  pending.resolve(
    new Proxy([f.tab], {
      get(target, key, receiver) {
        if (key !== "then") fields.push(key);
        return Reflect.get(target, key, receiver);
      },
    }),
  );
  expect(await reading).toBeNull();
  expect(fields).toEqual([]);
  expect(f.access.window).not.toHaveBeenCalled();
});

it.each([
  { incognito: true },
  { active: false },
  { windowId: 99 },
  { id: -1 },
  { id: undefined },
])("never inspects URL/title for invalid tab context: %j", async (change) => {
  const f = fixture();
  Object.assign(f.tab, change);
  const url = vi.fn(() => "https://private.test"),
    title = vi.fn(() => "Must not be read");
  Object.defineProperties(f.tab, { url: { get: url }, title: { get: title } });
  expect(await focusedBrowserTab(f.access, f.authorized)).toBeNull();
  expect(url).not.toHaveBeenCalled();
  expect(title).not.toHaveBeenCalled();
  expect(f.access.window).not.toHaveBeenCalled();
});

it("skips ambiguous active tabs and a window that loses focus while its query is pending", async () => {
  const f = fixture();
  f.access.activeTabs.mockResolvedValueOnce([f.tab, { ...f.tab, id: 3 }]);
  expect(await focusedBrowserTab(f.access, f.authorized)).toBeNull();
  f.access.window.mockResolvedValueOnce({ ...f.window, focused: false });
  const title = vi.fn(() => "Must not be read");
  Object.defineProperty(f.tab, "title", { get: title });
  expect(await focusedBrowserTab(f.access, f.authorized)).toBeNull();
  expect(title).not.toHaveBeenCalled();
});

it("returns lazy fields only after a normal focus recheck and releases them on revocation", async () => {
  const f = fixture();
  const url = vi.fn(() => "https://synthetic.test/page"),
    title = vi.fn(() => "Synthetic title");
  Object.defineProperties(f.tab, { url: { get: url }, title: { get: title } });
  const result = await focusedBrowserTab(f.access, f.authorized);
  expect(result).toMatchObject({
    id: 2,
    windowId: 1,
    active: true,
    focused: true,
    incognito: false,
  });
  expect(f.access.window).toHaveBeenCalledWith(1);
  expect(url).not.toHaveBeenCalled();
  expect(title).not.toHaveBeenCalled();
  expect(result!.url).toBe("https://synthetic.test/page");
  expect(result!.title).toBe("Synthetic title");
  f.revoke();
  expect(result!.url).toBeUndefined();
  expect(result!.title).toBeUndefined();
  expect(url).toHaveBeenCalledOnce();
  expect(title).toHaveBeenCalledOnce();
});

it("applies controller site exclusions before reading provider titles and drains pending API work on off", async () => {
  const f = fixture(),
    sent: NativeBrowserMessage[] = [];
  const id = "00000000-0000-4000-8000-000000000001";
  const title = vi.fn(() => "Excluded title must not be read");
  Object.defineProperty(f.tab, "title", { get: title });
  const controller = new BrowserMetadataController({
    connectionId: id,
    browser: "chrome",
    now: () => Date.parse("2026-11-17T12:00:00.000Z"),
    monotonicNow: () => 0,
    getFocusedTab: (authorized) => focusedBrowserTab(f.access, authorized),
    send: (message) => sent.push(message),
    unavailable: vi.fn(),
  });
  await controller.permission(true);
  const state = {
    version: 2,
    type: "state",
    connectionId: id,
    browser: "chrome",
    revision: 1,
    authority: {
      sessionId: id,
      generationId: id,
      capability: "a".repeat(64),
      expiresAt: "2026-11-17T12:00:03.000Z",
      validForMs: 3000,
      excludedSiteHosts: ["synthetic.test"],
    },
  };
  expect((await controller.state(state)).ok).toBe(true);
  await controller.sample();
  expect(title).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
  const pending = deferred<BrowserWindowMetadata>();
  f.access.lastFocusedWindow.mockReturnValueOnce(pending.promise);
  const sample = controller.sample();
  let stopped = false;
  const off = controller
    .state({ ...state, revision: 2, authority: null })
    .then(() => {
      stopped = true;
    });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(sent).toEqual([]);
  pending.resolve(f.window);
  await sample;
  await off;
  expect(f.access.activeTabs).toHaveBeenCalledOnce(); // No second query starts after the off revision.
  expect(sent).toEqual([
    { version: 2, type: "stopped", connectionId: id, revision: 2 },
  ]);
});
