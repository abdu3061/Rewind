import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerRuntimeOptions } from "./worker-runtime";
import type { RuntimeSnapshot } from "@rewind/contracts";

const behavior = vi.hoisted(() => ({ shutdown: vi.fn() }));
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
      constructor(private options: WorkerRuntimeOptions) {}
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  if (previousPort) Object.defineProperty(process, "parentPort", previousPort);
  else Reflect.deleteProperty(process, "parentPort");
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
