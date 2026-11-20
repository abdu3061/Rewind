import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  preferencesResponseSchema,
  type RuntimeSnapshot,
  type WorkerInput,
  type BrowserAssetsLocation,
  browserControlResponseSchema,
  assistantControlResponseSchema,
  assistantAnswerResponseSchema,
  boundedWorkerMessage,
  recordingCommandSchema,
  type DocumentText,
} from "@rewind/contracts";
import {
  WorkerClient,
  type WorkerClientOptions,
  type WorkerTransport,
} from "./worker-client";
const ready = (): RuntimeSnapshot => ({
  documentAuthority: {
    generation: "00000000-0000-4000-8000-000000000001",
    revision: 0,
  },
  assistant: {
    generation: "00000000-0000-4000-8000-000000000001",
    configured: false,
    permission: false,
    busy: false,
    credentialPending: false,
    revision: 0,
  },
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
function fixture(
  browserAssets?: BrowserAssetsLocation,
  requestTimeoutMs: number | null = 30,
  documents?: WorkerClientOptions["documents"],
) {
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
    ...(documents ? { documents } : {}),
    ...(browserAssets ? { browserAssets } : {}),
    loadKey: async () => ({ ok: true, value: randomBytes(32) }),
    spawn,
    onSnapshot: vi.fn(),
    onActivity: vi.fn(),
    startupTimeoutMs: 30,
    ...(requestTimeoutMs === null ? {} : { requestTimeoutMs }),
  });
  clients.push(client);
  return { client, children, spawn };
}

const documentText: DocumentText = {
  state: "available",
  format: "pdf",
  text: "synthetic document relay",
  truncated: false,
  pagesRead: 1,
  totalPages: 1,
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
it("allows remembered local startup only on the first worker boot, keeping reconnect default-off", async () => {
  const f = fixture();
  expect((await f.client.start()).ok).toBe(true);
  expect(
    f.children[0]!.messages.find((message) => message.type === "init"),
  ).toMatchObject({ automaticStart: true });
  f.children[0]!.emit("exit", 1);
  expect((await f.client.retry()).ok).toBe(true);
  expect(
    f.children[1]!.messages.find((message) => message.type === "init"),
  ).toMatchObject({ automaticStart: false });
  expect(f.client.getSnapshot()).toMatchObject({
    collection: "off",
    filePermission: false,
  });
});
function documentFixture() {
  const documents = {
    busy: false,
    extract: vi.fn(async () => documentText),
    stop: vi.fn(async () => true),
  };
  return { ...fixture(undefined, 30, documents), documents };
}
it("mediates private bounded binary bytes without JSON serialization or a public capability", async () => {
  const f = documentFixture();
  await f.client.start();
  const child = f.children[0]!;
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(53),
    id = randomUUID();
  const request = {
    version: 1,
    type: "document-parse",
    id,
    bootId: child.messages[0]!.bootId,
    format: "pdf",
    bytes,
  };
  const json = vi.spyOn(JSON, "stringify");
  expect(boundedWorkerMessage(request)).toBe(false);
  expect(recordingCommandSchema.safeParse(request).success).toBe(false);
  child.emit("message", request);
  await flush();
  // Zod may stringify small discriminator/key names; document bytes/envelopes must never enter it.
  expect(
    json.mock.calls.filter(
      ([value]) =>
        value instanceof Uint8Array ||
        (value !== null && typeof value === "object" && "bytes" in value),
    ).length,
  ).toBe(0);
  json.mockRestore();
  expect(f.documents.extract).toHaveBeenCalledTimes(1);
  expect(child.messages.at(-1)).toMatchObject({
    type: "document-result",
    id,
    result: documentText,
    closed: true,
  });
  expect(bytes.every((value) => value === 0)).toBe(true);
});
it("keeps closure unconfirmed when a document process survives a result", async () => {
  const f = documentFixture();
  await f.client.start();
  const child = f.children[0]!;
  f.documents.busy = true;
  f.documents.stop.mockResolvedValue(false);
  child.emit("message", {
    version: 1,
    type: "document-parse",
    id: randomUUID(),
    bootId: child.messages[0]!.bootId,
    format: "pdf",
    bytes: Uint8Array.of(1),
  });
  await flush();
  expect(child.messages.at(-1)).toMatchObject({
    type: "document-result",
    closed: false,
  });
  const id = randomUUID();
  child.emit("message", {
    version: 1,
    type: "document-stop",
    id,
    bootId: child.messages[0]!.bootId,
  });
  await flush();
  expect(child.messages.at(-1)).toMatchObject({
    type: "document-stopped",
    id,
    closed: false,
  });
  f.documents.busy = false;
  f.documents.stop.mockResolvedValue(true);
});
it("refuses overlapping private parse requests and wipes refused bytes", async () => {
  const f = documentFixture();
  let resolve!: (text: DocumentText) => void;
  f.documents.extract.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.client.start();
  const child = f.children[0]!,
    bootId = child.messages[0]!.bootId;
  child.emit("message", {
    version: 1,
    type: "document-parse",
    id: randomUUID(),
    bootId,
    format: "pdf",
    bytes: Uint8Array.of(1),
  });
  const bytes = Uint8Array.of(2),
    id = randomUUID();
  child.emit("message", {
    version: 1,
    type: "document-parse",
    id,
    bootId,
    format: "pdf",
    bytes,
  });
  expect(child.messages.at(-1)).toMatchObject({
    type: "document-result",
    id,
    closed: false,
  });
  expect(bytes[0]).toBe(0);
  expect(f.documents.extract).toHaveBeenCalledTimes(1);
  resolve(documentText);
  await flush();
});
it("rejects stale binary boot messages before invoking the parser", async () => {
  const f = documentFixture();
  await f.client.start();
  const bytes = Uint8Array.of(1);
  f.children[0]!.emit("message", {
    version: 1,
    type: "document-parse",
    id: randomUUID(),
    bootId: randomUUID(),
    format: "pdf",
    bytes,
  });
  expect(bytes[0]).toBe(0);
  expect(f.documents.extract).not.toHaveBeenCalled();
});
it("fails closed on an oversized private document message without stringifying bytes", async () => {
  const f = documentFixture();
  await f.client.start();
  const json = vi.spyOn(JSON, "stringify");
  f.children[0]!.emit("message", {
    version: 1,
    type: "document-parse",
    id: randomUUID(),
    bootId: f.children[0]!.messages[0]!.bootId,
    format: "pdf",
    bytes: new Uint8Array(16 * 1024 * 1024 + 1),
  });
  expect(json).not.toHaveBeenCalled();
  json.mockRestore();
  expect(f.client.getSnapshot().service).toBe("unavailable");
  expect(f.documents.extract).not.toHaveBeenCalled();
});
it("does not acknowledge shutdown or reconnect while document stop remains unconfirmed", async () => {
  const f = documentFixture();
  await f.client.start();
  f.documents.stop.mockResolvedValue(false);
  expect((await f.client.shutdown()).ok).toBe(false);
  f.children[0]!.emit("message", { invalid: true });
  expect((await f.client.retry()).ok).toBe(false);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  f.documents.stop.mockResolvedValue(true);
  expect((await f.client.retry()).ok).toBe(true);
  expect(f.spawn).toHaveBeenCalledTimes(2);
});
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
it.each([
  { kind: "assistant.permission", enabled: false },
  { kind: "assistant.stop" },
  { kind: "assistant.forget", confirmed: true },
] as const)(
  "stops the worker instead of dropping $kind behind a saturated request map",
  async (command) => {
    const f = fixture();
    await f.client.start();
    f.children[0]!.replyAutomatically = false;
    const pending = Array.from({ length: 64 }, () => f.client.execute("get"));
    expect(
      (await f.client.request(command, assistantControlResponseSchema)).ok,
    ).toBe(false);
    expect(f.client.getSnapshot().service).toBe("unavailable");
    expect((await Promise.all(pending)).every((result) => !result.ok)).toBe(
      true,
    );
  },
);
it("allows the bounded model request to finish beyond the ordinary command deadline", async () => {
  vi.useFakeTimers();
  const f = fixture(undefined, null);
  await f.client.start();
  const child = f.children[0]!;
  child.replyAutomatically = false;
  const asking = f.client.request(
    {
      kind: "assistant.ask",
      value: { id: randomUUID(), keys: ["E1"], confirmed: true },
    },
    assistantAnswerResponseSchema,
  );
  const command = child.messages
    .filter((message) => message.type === "command")
    .at(-1);
  if (!command || command.type !== "command")
    throw new Error("SYNTHETIC_COMMAND_MISSING");
  await vi.advanceTimersByTimeAsync(39999);
  expect(f.client.getSnapshot().service).toBe("ready");
  child.reply(command, {
    generation: randomUUID(),
    answer: {
      text: "Insufficient synthetic evidence.",
      sources: [],
      insufficientEvidence: true,
    },
    revision: 1,
    expiresAt: new Date().toISOString(),
  });
  expect((await asking).ok).toBe(true);
  child.replyAutomatically = true;
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
it.each(["active", "browser", "files", "cloud"] as const)(
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
                : mode === "cloud"
                  ? {
                      assistant: {
                        ...ready().assistant,
                        configured: true,
                        permission: true,
                      },
                    }
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
