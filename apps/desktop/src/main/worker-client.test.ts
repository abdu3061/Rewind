import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  preferencesResponseSchema,
  type RuntimeSnapshot,
  type WorkerInput,
  type BrowserAssetsLocation,
  browserControlResponseSchema,
} from "@rewind/contracts";
import { WorkerClient, type WorkerTransport } from "./worker-client";
const ready = (): RuntimeSnapshot => ({
  service: "ready",
  collection: "off",
  secureStorage: true,
  filePermission: false,
  browserPermission: false,
  synthetic: true,
  preferences: { collectionConsent: false, excludedApplications: [] },
  session: null,
  error: null,
  revision: 0,
});
class SyntheticTransport extends EventEmitter implements WorkerTransport {
  messages: WorkerInput[] = [];
  killWorks = true;
  autoReady = true;
  replyAutomatically = true;
  postMessage(value: WorkerInput): void {
    const message = structuredClone(value);
    this.messages.push(message);
    if (message.type === "init" && this.autoReady)
      queueMicrotask(() =>
        this.emit("message", {
          version: 1,
          bootId: message.bootId,
          type: "ready",
          state: ready(),
        }),
      );
    if (message.type === "command" && this.replyAutomatically)
      queueMicrotask(() =>
        this.reply(
          message,
          message.command.kind === "shutdown"
            ? true
            : message.command.kind === "session"
              ? { session: null }
              : ready().preferences,
        ),
      );
  }
  reply(
    message: Extract<WorkerInput, { type: "command" }>,
    value: unknown,
  ): void {
    this.emit("message", {
      version: 1,
      bootId: message.bootId,
      type: "reply",
      id: message.id,
      kind: message.command.kind,
      result: { ok: true, value },
    });
  }
  kill(): boolean {
    if (this.killWorks) this.emit("exit", 0);
    return this.killWorks;
  }
}
const clients: WorkerClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.shutdown();
  vi.useRealTimers();
});
function fixture(browserAssets?: BrowserAssetsLocation) {
  const children: SyntheticTransport[] = [];
  const spawn = vi.fn(() => {
    const child = new SyntheticTransport();
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const client = new WorkerClient({
    root: "C:\\synthetic-fixture",
    synthetic: true,
    ...(browserAssets ? { browserAssets } : {}),
    loadKey: async () => ({ ok: true, value: randomBytes(32) }),
    spawn,
    onSnapshot: vi.fn(),
    onActivity: vi.fn(),
    startupTimeoutMs: 30,
    requestTimeoutMs: 30,
  });
  clients.push(client);
  return { client, children, spawn };
}
it("starts with verified storage and no grant and acknowledges shutdown before exit", async () => {
  const f = fixture();
  expect((await f.client.start()).ok).toBe(true);
  expect(f.client.getSnapshot()).toMatchObject({
    collection: "off",
    secureStorage: true,
    preferences: { collectionConsent: false },
  });
  expect((await f.client.execute("get")).ok).toBe(true);
  expect((await f.client.shutdown()).ok).toBe(true);
});
it("sends main-owned browser asset locations only in private initialization, without adding a grant or public snapshot field", async () => {
  const browserAssets = {
    root: "C:\\SyntheticFixture\\browser-assets",
    desktopPath: "C:\\SyntheticFixture\\Rewind.exe",
  };
  const f = fixture(browserAssets);
  expect((await f.client.start()).ok).toBe(true);
  const init = f.children[0]!.messages.find(
    (message) => message.type === "init",
  );
  expect(init).toMatchObject({ type: "init", browserAssets });
  expect(f.client.getSnapshot()).not.toHaveProperty("browserAssets");
  expect(f.client.getSnapshot().browserPermission).toBe(false);
});
it("terminates recording instead of dropping revocation behind a saturated request map", async () => {
  const f = fixture();
  await f.client.start();
  const child = f.children[0]!;
  child.replyAutomatically = false;
  const pending = Array.from({ length: 64 }, () => f.client.execute("get"));
  const revoked = await f.client.request(
    {
      kind: "preferences.update",
      value: { collectionConsent: false, excludedApplications: [] },
    },
    preferencesResponseSchema,
  );
  expect(revoked.ok).toBe(false);
  expect(f.client.getSnapshot()).toMatchObject({
    service: "unavailable",
    preferences: { collectionConsent: false },
  });
  expect((await Promise.all(pending)).every((result) => !result.ok)).toBe(true);
  expect((await f.client.retry()).ok).toBe(true);
  expect(f.spawn).toHaveBeenCalledTimes(2);
});
it("stops the worker instead of dropping browser denial behind a saturated request map", async () => {
  const f = fixture();
  await f.client.start();
  f.children[0]!.replyAutomatically = false;
  const pending = Array.from({ length: 64 }, () => f.client.execute("get"));
  const revoked = await f.client.request(
    { kind: "browser.permission", enabled: false },
    browserControlResponseSchema,
  );
  expect(revoked.ok).toBe(false);
  expect(f.client.getSnapshot()).toMatchObject({
    service: "unavailable",
    browserPermission: false,
  });
  expect((await Promise.all(pending)).every((result) => !result.ok)).toBe(true);
  expect((await f.client.retry()).ok).toBe(true);
  expect(f.client.getSnapshot().browserPermission).toBe(false);
});
it("routes concurrent replies by request ID even when they arrive out of order", async () => {
  const f = fixture();
  await f.client.start();
  const child = f.children[0]!;
  child.replyAutomatically = false;
  const first = f.client.execute("get");
  const second = f.client.request(
    { kind: "preferences.get" },
    preferencesResponseSchema,
  );
  const commands = child.messages.filter(
    (message): message is Extract<WorkerInput, { type: "command" }> =>
      message.type === "command",
  );
  child.reply(commands[1]!, ready().preferences);
  child.reply(commands[0]!, { session: null });
  expect(await first).toEqual({ ok: true, value: { session: null } });
  expect(await second).toEqual({ ok: true, value: ready().preferences });
  child.replyAutomatically = true;
});
it("rejects pending work on worker crash and starts a fresh ungranted generation on retry", async () => {
  const f = fixture();
  await f.client.start();
  const old = f.children[0]!;
  old.replyAutomatically = false;
  const pending = f.client.execute("start");
  old.emit("exit", 1);
  expect((await pending).ok).toBe(false);
  expect(f.client.getSnapshot().service).toBe("unavailable");
  expect((await f.client.retry()).ok).toBe(true);
  const init = old.messages.find((message) => message.type === "init")!;
  old.emit("message", {
    version: 1,
    bootId: init.bootId,
    type: "snapshot",
    state: {
      ...ready(),
      collection: "active",
      preferences: { ...ready().preferences, collectionConsent: true },
    },
  });
  expect(f.client.getSnapshot().collection).toBe("off");
  expect(f.spawn).toHaveBeenCalledTimes(2);
});
it("fails closed on malformed response values", async () => {
  const f = fixture();
  await f.client.start();
  const child = f.children[0]!;
  child.replyAutomatically = false;
  const pending = f.client.execute("get");
  const message = child.messages
    .filter(
      (value): value is Extract<WorkerInput, { type: "command" }> =>
        value.type === "command",
    )
    .at(-1)!;
  child.reply(message, "invalid state");
  expect((await pending).ok).toBe(false);
  expect(f.client.getSnapshot().service).toBe("unavailable");
});
it("times out a hung worker and never accepts a late success", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.client.start();
  const child = f.children[0]!;
  child.replyAutomatically = false;
  const pending = f.client.execute("get");
  const message = child.messages
    .filter(
      (value): value is Extract<WorkerInput, { type: "command" }> =>
        value.type === "command",
    )
    .at(-1)!;
  await vi.advanceTimersByTimeAsync(31);
  expect((await pending).ok).toBe(false);
  child.reply(message, { session: null });
  expect(f.client.getSnapshot().service).toBe("unavailable");
  expect(vi.getTimerCount()).toBe(0);
});
it("does not launch a second worker while a failed worker survives termination", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.client.start();
  const child = f.children[0]!;
  child.killWorks = false;
  child.emit("message", { malformed: true });
  const retry = f.client.retry();
  await vi.advanceTimersByTimeAsync(2001);
  expect((await retry).ok).toBe(false);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  child.killWorks = true;
  child.emit("exit", 0);
});
it.each(["active", "browser", "files"] as const)(
  "rejects a forged ready message with %s monitoring authority",
  async (mode) => {
    const f = fixture();
    f.spawn.mockImplementationOnce(() => {
      const child = new SyntheticTransport();
      child.autoReady = false;
      f.children.push(child);
      queueMicrotask(() => {
        child.emit("spawn");
        const init = child.messages[0]!;
        child.emit("message", {
          version: 1,
          bootId: init.bootId,
          type: "ready",
          state: {
            ...ready(),
            ...(mode === "active"
              ? {
                  collection: "active",
                  preferences: {
                    ...ready().preferences,
                    collectionConsent: true,
                  },
                }
              : mode === "browser"
                ? { browserPermission: true }
                : { filePermission: true }),
          },
        });
      });
      return child;
    });
    expect((await f.client.start()).ok).toBe(false);
    expect(f.client.getSnapshot().secureStorage).toBe(false);
  },
);
