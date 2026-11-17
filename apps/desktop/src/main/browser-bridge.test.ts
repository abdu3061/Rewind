import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  BrowserTransportListener,
  NativeBrowserState,
} from "@rewind/contracts";
import { NativeBrowserBridge, type NativeBridgeConfig } from "./browser-bridge";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const config: NativeBridgeConfig = {
  version: 1,
  pipeName: "rewind.unit.synthetic",
  desktopPath: "C:\\Fixture\\Desktop.exe",
  desktopHash: "a".repeat(64),
  hostHash: "b".repeat(64),
  origins: [`chrome-extension://${"a".repeat(32)}/`],
  browsers: [{ kind: "chrome", path: "C:\\Fixture\\chrome.exe" }],
};
const hello = {
  version: 2,
  type: "hello",
  connectionId: id(2),
  profileId: id(3),
};
const state: NativeBrowserState = {
  version: 2,
  type: "state",
  connectionId: id(2),
  revision: 1,
  browser: "chrome",
  authority: null,
};
const turn = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
};
const cleanups: (() => Promise<void>)[] = [];
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    }),
  });
  const commands: Record<string, unknown>[] = [];
  child.stdin.on("data", (bytes: Buffer) => {
    const command = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    commands.push(command);
    if (command.type === "shutdown")
      queueMicrotask(() => child.emit("close", 0, null));
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ChildProcessWithoutNullStreams,
  );
  const listener: BrowserTransportListener = {
    connected: vi.fn(),
    message: vi.fn(),
    disconnected: vi.fn(),
    unavailable: vi.fn(),
  };
  const bridge = new NativeBrowserBridge();
  bridge.setListener(listener);
  const emit = (value: unknown) =>
    child.stdout.write(Buffer.from(JSON.stringify(value) + "\r\n", "utf8"));
  const connected = () =>
    emit({
      type: "connected",
      channelId: id(1),
      browser: "chrome",
      origin: config.origins[0],
    });
  const message = (value: unknown, channelId = id(1)) =>
    emit({
      type: "message",
      channelId,
      payload: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
    });
  const begin = async () => {
    const started = bridge.start("C:\\Fixture\\Native.exe", config);
    emit({ type: "ready" });
    expect((await started).ok).toBe(true);
  };
  cleanups.push(async () => {
    child.emit("close", 0, null);
    await bridge.close();
  });
  return { bridge, child, listener, commands, emit, connected, message, begin };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

it("starts hidden with private configuration and waits for the actual broker ready event", async () => {
  const f = fixture();
  let settled = false;
  const started = f.bridge
    .start("C:\\Fixture\\Native.exe", config)
    .then((result) => {
      settled = true;
      return result;
    });
  await turn();
  expect(settled).toBe(false);
  expect(spawn).toHaveBeenCalledWith("C:\\Fixture\\Native.exe", ["--broker"], {
    windowsHide: true,
    stdio: "pipe",
  });
  expect(f.commands).toEqual([config]);
  f.emit({ type: "ready" });
  expect((await started).ok).toBe(true);
  expect(f.bridge.status()).toEqual({ state: "ready", connected: 0 });
  expect(f.listener.message).not.toHaveBeenCalled();
  expect(f.commands).toHaveLength(1); // A passive transport never invents a collection lease.
});

it("rejects invalid setup before spawning and refuses a second live helper/listener", async () => {
  const f = fixture();
  for (const candidate of [
    { ...config, origins: ["chrome-extension://*/"] },
    { ...config, desktopPath: "\\\\remote\\share\\app.exe" },
    { ...config, browsers: [config.browsers[0]!, config.browsers[0]!] },
  ])
    expect(
      (await f.bridge.start("C:\\Fixture\\Native.exe", candidate)).ok,
    ).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
  await f.begin();
  expect((await f.bridge.start("C:\\Fixture\\Native.exe", config)).ok).toBe(
    false,
  );
  expect(() => f.bridge.setListener(f.listener)).toThrow(
    "BROWSER_LISTENER_ALREADY_SET",
  );
});

it("forwards only authenticated configured peers and bounded strict v2 bodies, with lossless split Unicode", async () => {
  const f = fixture();
  await f.begin();
  f.connected();
  const bytes = Buffer.from(
    JSON.stringify({
      type: "message",
      channelId: id(1),
      payload: Buffer.from(JSON.stringify(hello), "utf8").toString("base64"),
    }) + "\n",
    "utf8",
  );
  for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
  expect(f.listener.connected).toHaveBeenCalledWith({
    id: id(1),
    browser: "chrome",
    origin: config.origins[0],
  });
  expect(f.listener.message).toHaveBeenCalledWith(id(1), hello);
  const visit = {
    version: 2,
    type: "visit",
    connectionId: id(2),
    sessionId: id(4),
    generationId: id(5),
    capability: "c".repeat(64),
    sequence: 1,
    occurredAt: "2026-11-17T12:00:00.000Z",
    incognito: false,
    focused: true,
    url: "https://example.test/page",
    title: "Synthetic \u00e7al\u0131\u015fma \ud83e\uddea",
  };
  f.message(visit);
  expect(f.listener.message).toHaveBeenLastCalledWith(id(1), visit);
  expect(f.bridge.send(id(1), state).ok).toBe(true);
  expect(f.commands.at(-1)).toEqual({
    type: "send",
    channelId: id(1),
    payload: expect.any(String),
  });
  expect(
    JSON.parse(
      Buffer.from(f.commands.at(-1)!.payload as string, "base64").toString(
        "utf8",
      ),
    ),
  ).toEqual(state);
});

it.each([
  { type: "hello", version: 1, connectionId: id(2), profileId: id(3) },
  { ...hello, expanded: true },
  { ...hello, connectionId: "invalid" },
])(
  "disconnects an invalid client without treating it as a new root protocol: %j",
  async (bad) => {
    const f = fixture();
    await f.begin();
    f.connected();
    f.message(bad);
    expect(f.listener.message).not.toHaveBeenCalled();
    expect(f.commands.at(-1)).toEqual({ type: "disconnect", channelId: id(1) });
    expect(f.listener.disconnected).not.toHaveBeenCalled();
    f.message(hello); // Ignore data already queued behind an explicit disconnect.
    expect(f.listener.message).not.toHaveBeenCalled();
    f.emit({ type: "disconnected", channelId: id(1) });
    expect(f.listener.disconnected).toHaveBeenCalledWith(id(1));
    expect(f.bridge.status().state).toBe("ready");
  },
);

it("requires hello within the deadline and rejects noncanonical base64/UTF-8 without logging content", async () => {
  const f = fixture();
  await f.begin();
  f.connected();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.commands.at(-1)).toEqual({ type: "disconnect", channelId: id(1) });
  f.emit({ type: "disconnected", channelId: id(1) });
  for (const payload of [
    "YQ==\n",
    Buffer.from([0xc0, 0xaf]).toString("base64"),
    Buffer.alloc(262145).toString("base64"),
  ]) {
    f.connected();
    f.emit({ type: "message", channelId: id(1), payload });
    expect(f.listener.message).not.toHaveBeenCalled();
    expect(f.commands.at(-1)).toEqual({ type: "disconnect", channelId: id(1) });
    f.emit({ type: "disconnected", channelId: id(1) });
  }
});

it.each([
  { type: "ready", extra: true },
  {
    type: "connected",
    channelId: id(1),
    browser: "chrome",
    origin: `chrome-extension://${"b".repeat(32)}/`,
  },
  {
    type: "connected",
    channelId: id(1),
    browser: "edge",
    origin: config.origins[0],
  },
  { type: "message", channelId: id(99), payload: "e30=" },
])(
  "kills an invalid private broker protocol and never starts a replacement before observed exit: %j",
  async (bad) => {
    const f = fixture();
    await f.begin();
    f.child.kill.mockImplementation(() => true); // Process liveness is not inferred from kill() returning true.
    f.emit(bad);
    expect(f.bridge.status().state).toBe("unavailable");
    expect(f.listener.unavailable).toHaveBeenCalledOnce();
    expect((await f.bridge.start("C:\\Fixture\\Native.exe", config)).ok).toBe(
      false,
    );
    f.child.stdin.removeAllListeners("data"); // A stuck child neither accepts shutdown nor reports close.
    const closing = f.bridge.close();
    await vi.advanceTimersByTimeAsync(4000);
    expect((await closing).ok).toBe(false);
    f.child.emit("close", 1, null);
    expect((await f.bridge.close()).ok).toBe(true);
  },
);

it("ignores rejected-native disconnections that never became authenticated peers", async () => {
  const f = fixture();
  await f.begin();
  f.emit({ type: "disconnected", channelId: id(99) });
  expect(f.listener.disconnected).not.toHaveBeenCalled();
  expect(f.bridge.status().state).toBe("ready");
});

it("fails closed on output limits and failed/backpressured outbound writes", async () => {
  const f = fixture();
  await f.begin();
  f.connected();
  f.message(hello);
  vi.spyOn(f.child.stdin, "write").mockReturnValueOnce(false);
  expect(f.bridge.send(id(1), state).ok).toBe(false);
  expect(f.child.kill).toHaveBeenCalled();
  expect(f.listener.unavailable).toHaveBeenCalledOnce();
  const g = fixture();
  await g.begin();
  g.child.stdout.write(Buffer.alloc(524289, 65));
  expect(g.bridge.status().state).toBe("unavailable");
});

it("times out startup, coalesces shutdown, observes child close and rejects mismatched outbound browser state", async () => {
  const f = fixture();
  const starting = f.bridge.start("C:\\Fixture\\Native.exe", config);
  await vi.advanceTimersByTimeAsync(10000);
  expect((await starting).ok).toBe(false);
  expect(f.listener.unavailable).toHaveBeenCalledOnce();
  const g = fixture();
  await g.begin();
  g.connected();
  g.message(hello);
  expect(g.bridge.send(id(1), { ...state, browser: "edge" }).ok).toBe(false);
  expect(g.bridge.send(id(99), state).ok).toBe(false);
  const first = g.bridge.close(),
    second = g.bridge.close();
  expect(first).toBe(second);
  expect((await first).ok).toBe(true);
  expect(g.bridge.status()).toEqual({ state: "off", connected: 0 });
  expect(g.listener.disconnected).toHaveBeenCalledWith(id(1));
});
