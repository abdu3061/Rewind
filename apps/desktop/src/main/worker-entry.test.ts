import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerRuntimeOptions } from "./worker-runtime";
import type { RuntimeSnapshot } from "@rewind/contracts";

const behavior = vi.hoisted(() => ({
  shutdown: vi.fn(),
  browserAssets: vi.fn(),
}));
vi.mock("./worker-runtime", () => {
  const state: RuntimeSnapshot = {
    service: "ready",
    collection: "off",
    session: null,
    preferences: { collectionConsent: false, excludedApplications: [] },
    secureStorage: true,
    filePermission: false,
    browserPermission: false,
    synthetic: true,
    error: null,
    revision: 0,
  };
  return {
    WorkerRuntime: class {
      constructor(private options: WorkerRuntimeOptions) {
        behavior.browserAssets(options.browserAssets);
      }
      async initialize() {
        return { ok: true, value: state };
      }
      async shutdown() {
        behavior.shutdown();
        // Real shutdown emits state changes synchronously while invalidating authority.
        this.options.onSnapshot({ ...state, service: "stopping" });
        return { ok: true, value: true };
      }
    },
  };
});
const previousPort = Object.getOwnPropertyDescriptor(process, "parentPort");
afterEach(() => {
  behavior.shutdown.mockClear();
  behavior.browserAssets.mockClear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  if (previousPort) Object.defineProperty(process, "parentPort", previousPort);
  else Reflect.deleteProperty(process, "parentPort");
});
it("forwards private browser composition metadata to the utility runtime without exposing it in ready state", async () => {
  vi.useFakeTimers();
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: port,
  });
  await import("./worker-entry");
  const browserAssets = {
    root: "C:\\SyntheticFixture\\browser-assets",
    desktopPath: "C:\\SyntheticFixture\\Rewind.exe",
  };
  port.emit("message", {
    data: {
      version: 1,
      type: "init",
      bootId: "00000000-0000-4000-8000-000000000001",
      root: "C:\\synthetic-fixture",
      key: new Uint8Array(32),
      synthetic: true,
      browserAssets,
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(behavior.browserAssets).toHaveBeenCalledWith(browserAssets);
  expect(port.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "ready" }),
  );
  expect(port.postMessage.mock.calls[0]?.[0]).not.toHaveProperty(
    "browserAssets",
  );
  expect(behavior.shutdown).not.toHaveBeenCalled();
});
it("shuts down once without recursive state publication when the parent port disconnects", async () => {
  vi.useFakeTimers();
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => {
      throw new Error("Synthetic disconnected parent");
    }),
  });
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: port,
  });
  await import("./worker-entry");
  port.emit("message", {
    data: {
      version: 1,
      type: "init",
      bootId: "00000000-0000-4000-8000-000000000001",
      root: "C:\\synthetic-fixture",
      key: new Uint8Array(32),
      synthetic: true,
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(port.postMessage).toHaveBeenCalledTimes(1);
  expect(behavior.shutdown).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(1);
});
