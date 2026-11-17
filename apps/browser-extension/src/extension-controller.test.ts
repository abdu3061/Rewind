import { afterEach, expect, it, vi } from "vitest";
import type { NativeBrowserMessage } from "@rewind/contracts";
import { ExtensionController } from "./extension-controller";
import {
  extensionControlSender,
  extensionControlContext,
  extensionControlContexts,
  browserDocumentIdSchema,
  extensionResponseSchema,
} from "./extension-controls";
import type { ExtensionNativePort } from "./native-session";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const turn = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
const authorized = async () => true;
const controllers: ExtensionController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let profile: unknown = id(1);
  const ports: {
    port: ExtensionNativePort;
    sent: NativeBrowserMessage[];
    message(input: unknown): void;
    disconnect(): void;
  }[] = [];
  const options = {
    loadProfile: vi.fn(async (): Promise<unknown> => profile),
    saveProfile: vi.fn(async (value: string) => {
      profile = value;
    }),
    hasBrowserPermissions: vi.fn(async () => true),
    getFocusedTab: vi.fn(async () => null),
    newId: () => id(50),
    connect: vi.fn(() => {
      const sent: NativeBrowserMessage[] = [],
        messages = new Set<(input: unknown) => void>(),
        disconnects = new Set<() => void>();
      const port: ExtensionNativePort = {
        postMessage: (message) => sent.push(structuredClone(message)),
        disconnect: vi.fn(),
        onMessage: (listener) => {
          messages.add(listener);
          return () => messages.delete(listener);
        },
        onDisconnect: (listener) => {
          disconnects.add(listener);
          return () => disconnects.delete(listener);
        },
      };
      ports.push({
        port,
        sent,
        message: (input) => {
          for (const listener of messages) listener(input);
        },
        disconnect: () => {
          for (const listener of disconnects) listener();
        },
      });
      return port;
    }),
  };
  const controller = new ExtensionController(options);
  controllers.push(controller);
  return {
    controller,
    options,
    ports,
    setProfile: (value: unknown) => {
      profile = value;
    },
  };
}

it("initializes a stable nonsecret profile without permissions, native connections or browser queries", async () => {
  const f = fixture();
  expect((await f.controller.initialize()).ok).toBe(true);
  expect(f.controller.status()).toEqual({
    service: "ready",
    permission: false,
    connected: false,
    collecting: false,
    pending: false,
    issue: null,
  });
  expect(f.options.saveProfile).not.toHaveBeenCalled();
  expect(f.options.hasBrowserPermissions).not.toHaveBeenCalled();
  expect(f.options.connect).not.toHaveBeenCalled();
  expect(f.options.getFocusedTab).not.toHaveBeenCalled();
});

it("creates and verifies only the profile tag; approval never survives a new controller/background", async () => {
  const f = fixture();
  f.setProfile(undefined);
  expect((await f.controller.initialize()).ok).toBe(true);
  expect(f.options.saveProfile).toHaveBeenCalledExactlyOnceWith(id(50));
  expect((await f.controller.permission(true)).ok).toBe(true);
  expect(f.ports[0]!.sent[0]).toMatchObject({
    type: "hello",
    profileId: id(50),
  });
  await f.controller.close();
  const restarted = new ExtensionController(f.options);
  controllers.push(restarted);
  expect((await restarted.initialize()).ok).toBe(true);
  expect(restarted.status().permission).toBe(false);
  expect(f.options.saveProfile).toHaveBeenCalledTimes(1);
  expect(f.options.connect).toHaveBeenCalledTimes(1);
});

it.each(["read", "write", "readback"] as const)(
  "fails closed on profile %s failure without an in-memory identity fallback",
  async (failure) => {
    const f = fixture();
    f.setProfile(null);
    if (failure === "read")
      f.options.loadProfile.mockRejectedValueOnce(
        new Error("Synthetic storage failure"),
      );
    if (failure === "write")
      f.options.saveProfile.mockRejectedValueOnce(
        new Error("Synthetic storage failure"),
      );
    if (failure === "readback")
      f.options.saveProfile.mockImplementationOnce(async () => {});
    expect((await f.controller.permission(true)).ok).toBe(false);
    expect(f.controller.status()).toMatchObject({
      service: "unavailable",
      permission: false,
    });
    expect(f.options.connect).not.toHaveBeenCalled();
    expect(f.options.getFocusedTab).not.toHaveBeenCalled();
    expect((await f.controller.permission(false)).ok).toBe(true);
  },
);

it("requires the browser's permissions before opening a native port and treats permission-check failures as denial", async () => {
  const f = fixture();
  f.options.hasBrowserPermissions
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error("Synthetic permission failure"));
  expect((await f.controller.permission(true)).ok).toBe(false);
  expect((await f.controller.permission(true)).ok).toBe(false);
  expect(f.options.connect).not.toHaveBeenCalled();
  expect(f.controller.status().permission).toBe(false);
});

it("a stop supersedes a grant while browser permission checks are pending", async () => {
  const f = fixture(),
    pending = deferred<boolean>();
  f.options.hasBrowserPermissions.mockReturnValueOnce(pending.promise);
  const enabling = f.controller.permission(true);
  await turn();
  expect(f.options.hasBrowserPermissions).toHaveBeenCalledOnce();
  expect((await f.controller.permission(false)).ok).toBe(true);
  pending.resolve(true);
  expect((await enabling).ok).toBe(false);
  expect(f.options.connect).not.toHaveBeenCalled();
});

it("denial retains priority when all eight ordinary command slots wait for initialization", async () => {
  const f = fixture(),
    profile = deferred<unknown>();
  f.options.loadProfile.mockReturnValueOnce(profile.promise);
  const pending = Array.from({ length: 8 }, () =>
    f.controller.request({ kind: "rewind.browser.status" }, authorized),
  );
  const grant = f.controller.permission(true);
  expect(
    await f.controller.request({ kind: "rewind.browser.status" }, authorized),
  ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  const stops = await Promise.all(
    Array.from({ length: 20 }, () =>
      f.controller.request(
        {
          kind: "rewind.browser.permission",
          enabled: false,
        },
        authorized,
      ),
    ),
  );
  expect(stops.at(-1)!.ok).toBe(true);
  profile.resolve(id(1));
  expect((await Promise.all(pending)).every((result) => result.ok)).toBe(true);
  expect((await grant).ok).toBe(false);
  expect(f.options.connect).not.toHaveBeenCalled();
  expect(f.controller.status().permission).toBe(false);
});

it("disconnect revocation invalidates another pending grant instead of silently reconnecting", async () => {
  const f = fixture();
  expect((await f.controller.permission(true)).ok).toBe(true);
  const pending = deferred<boolean>();
  f.options.hasBrowserPermissions.mockReturnValueOnce(pending.promise);
  const enabling = f.controller.permission(true);
  await turn();
  f.ports[0]!.disconnect();
  pending.resolve(true);
  expect((await enabling).ok).toBe(false);
  expect(f.controller.status()).toMatchObject({
    permission: false,
    connected: false,
    issue: "connection",
  });
  expect(f.options.connect).toHaveBeenCalledOnce();
});

it("rejects expanded/raw controls before storage or browser capabilities are invoked", async () => {
  const f = fixture();
  for (const input of [
    {
      kind: "rewind.browser.permission",
      enabled: true,
      capability: "synthetic",
    },
    { kind: "rewind.browser.status", path: "C:\\synthetic" },
    { kind: "native", data: {} },
    { kind: "rewind.browser.permission", enabled: "true" },
  ])
    expect(await f.controller.request(input, authorized)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  expect(f.options.loadProfile).not.toHaveBeenCalled();
  expect(f.options.connect).not.toHaveBeenCalled();
});

it("closes while initialization or a permission check is pending without allowing a late connection", async () => {
  const f = fixture(),
    profile = deferred<unknown>();
  f.options.loadProfile.mockReturnValueOnce(profile.promise);
  const initializing = f.controller.initialize();
  await f.controller.close();
  profile.resolve(id(1));
  expect((await initializing).ok).toBe(false);
  expect((await f.controller.permission(true)).ok).toBe(false);
  expect(f.options.connect).not.toHaveBeenCalled();
  const g = fixture(),
    permissions = deferred<boolean>();
  g.options.hasBrowserPermissions.mockReturnValueOnce(permissions.promise);
  const enabling = g.controller.permission(true);
  await turn();
  await g.controller.close();
  permissions.resolve(true);
  expect((await enabling).ok).toBe(false);
  expect(g.options.connect).not.toHaveBeenCalled();
});

it("authenticates the exact owned top-level controls location and rejects cross-origin, other extensions and subframes", () => {
  const extensionId = "a".repeat(32),
    origin = `chrome-extension://${extensionId}`;
  const sender = {
    id: extensionId,
    origin,
    url: `${origin}/status.html`,
    frameId: 0,
  };
  expect(extensionControlSender(sender, extensionId)).toBe(true);
  expect(
    browserDocumentIdSchema.safeParse("B39C2D10EFEB203EB88F81AABA46CDB6")
      .success,
  ).toBe(true);
  expect(browserDocumentIdSchema.safeParse(id(1)).success).toBe(true);
  expect(
    browserDocumentIdSchema.safeParse("synthetic-invalid-document").success,
  ).toBe(false);
  const context = {
    documentId: id(1),
    documentOrigin: origin,
    documentUrl: sender.url,
    frameId: 0,
    contextType: "POPUP",
    incognito: false,
  };
  expect(extensionControlContext(context, id(1), extensionId)).toBe(true);
  expect(
    extensionControlContexts([context], { hasTab: false }, extensionId),
  ).toBe(true);
  expect(
    extensionControlContexts(
      [context, context],
      { hasTab: false },
      extensionId,
    ),
  ).toBe(false);
  expect(
    extensionControlContexts([context], { hasTab: true }, extensionId),
  ).toBe(false);
  expect(
    extensionControlContexts(
      [{ ...context, contextType: "TAB" }],
      { hasTab: false },
      extensionId,
    ),
  ).toBe(false);
  for (const change of [
    { frameId: 1 },
    { documentId: id(2) },
    { documentUrl: `${origin}/background.js` },
    { contextType: "BACKGROUND" },
    { incognito: true },
  ])
    expect(
      extensionControlContext({ ...context, ...change }, id(1), extensionId),
    ).toBe(false);
  for (const change of [
    { id: "b".repeat(32) },
    { url: `${origin}/background.js` },
    { url: `${origin}/status.html?grant=true` },
    { origin: "https://synthetic.test" },
    { origin: undefined },
    { frameId: 1 },
  ])
    expect(extensionControlSender({ ...sender, ...change }, extensionId)).toBe(
      false,
    );
  expect(
    extensionResponseSchema.safeParse({
      ok: true,
      value: {
        service: "ready",
        permission: true,
        connected: true,
        collecting: false,
        pending: false,
        issue: null,
        url: "https://synthetic.test",
      },
    }).success,
  ).toBe(false);
});

it("an earlier grant cannot overtake a later denial while main-frame authorization is pending", async () => {
  const f = fixture(),
    proof = deferred<boolean>();
  const enabling = f.controller.request(
    { kind: "rewind.browser.permission", enabled: true },
    () => proof.promise,
  );
  expect(
    (
      await f.controller.request(
        { kind: "rewind.browser.permission", enabled: false },
        authorized,
      )
    ).ok,
  ).toBe(true);
  proof.resolve(true);
  expect((await enabling).ok).toBe(false);
  expect(f.options.connect).not.toHaveBeenCalled();
  expect(
    await f.controller.request(
      { kind: "rewind.browser.permission", enabled: true },
      async () => false,
    ),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(f.options.connect).not.toHaveBeenCalled();
});

it("trusted install/startup/permission revocation also cancels a grant waiting for document proof", async () => {
  const f = fixture(),
    proof = deferred<boolean>();
  const enabling = f.controller.request(
    { kind: "rewind.browser.permission", enabled: true },
    () => proof.promise,
  );
  await f.controller.permission(false);
  proof.resolve(true);
  expect((await enabling).ok).toBe(false);
  expect(f.options.connect).not.toHaveBeenCalled();
});

it("native failure also invalidates a grant whose main-frame proof is still pending", async () => {
  const f = fixture();
  await f.controller.permission(true);
  const proof = deferred<boolean>();
  const enabling = f.controller.request(
    { kind: "rewind.browser.permission", enabled: true },
    () => proof.promise,
  );
  f.ports[0]!.disconnect();
  proof.resolve(true);
  expect((await enabling).ok).toBe(false);
  expect(f.options.connect).toHaveBeenCalledOnce();
  expect(f.controller.status().permission).toBe(false);
});

it("bounds authorization work before calling browser context APIs and reserves denial", async () => {
  const f = fixture(),
    proof = deferred<boolean>(),
    authorize = vi.fn(() => proof.promise);
  const pending = Array.from({ length: 8 }, () =>
    f.controller.request({ kind: "rewind.browser.status" }, authorize),
  );
  expect(
    await f.controller.request({ kind: "rewind.browser.status" }, authorize),
  ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expect(authorize).toHaveBeenCalledTimes(8);
  expect(
    (
      await f.controller.request(
        { kind: "rewind.browser.permission", enabled: false },
        authorized,
      )
    ).ok,
  ).toBe(true);
  proof.resolve(true);
  expect((await Promise.all(pending)).every((result) => result.ok)).toBe(true);
  expect(f.options.connect).not.toHaveBeenCalled();
});
