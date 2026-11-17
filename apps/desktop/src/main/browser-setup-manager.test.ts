import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  browserSetupJournalSchema,
  createBrowserSetupJournal,
  failure,
  type BrowserSetupGeneration,
  type BrowserSetupJournal,
  type Result,
} from "@rewind/contracts";
import { BrowserSetupManager } from "./browser-setup-manager";
import type { BrowserInstallation } from "./browser-installation-files";
import type { VerifiedBrowserAssets } from "./browser-assets";
import { browserHostName, developmentExtensionId } from "./browser-assets";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let state = createBrowserSetupJournal();
  const events: string[] = [],
    files = new Map<string, BrowserInstallation>();
  const native = Buffer.alloc(23552, 1),
    nativeHash = createHash("sha256").update(native).digest("hex");
  const assets: VerifiedBrowserAssets = {
    native,
    extensionDirectory: "C:\\SyntheticFixture\\extension",
    inventory: {
      version: 1,
      hostName: browserHostName,
      extensionId: developmentExtensionId,
      nativeSourceHash: "e".repeat(64),
      native: {
        name: "RewindBrowserHost.exe",
        bytes: native.length,
        sha256: nativeHash,
      },
      extension: [],
    },
  };
  const desktop = {
    path: "C:\\SyntheticFixture\\Rewind.exe",
    hash: "d".repeat(64),
  };
  const locations = (generation: BrowserSetupGeneration) => ({
    executable: `C:\\SyntheticFixture\\browser-host\\g-${generation.id}\\RewindBrowserHost.exe`,
    manifest: `C:\\SyntheticFixture\\browser-host\\g-${generation.id}\\native-host.json`,
  });
  const registrations: Record<"chrome" | "edge", string | null> = {
    chrome: null,
    edge: null,
  };
  const options = {
    store: {
      read: vi.fn(async (): Promise<Result<BrowserSetupJournal>> =>
        ok(structuredClone(state)),
      ),
      write: vi.fn(
        async (
          expected: number,
          next: BrowserSetupJournal,
        ): Promise<Result<void>> => {
          events.push(next.pending ? "journal:pending" : "journal:complete");
          if (state.revision !== expected)
            return failure("CONFLICT", "Synthetic revision conflict.");
          state = browserSetupJournalSchema.parse(structuredClone(next));
          return ok(undefined);
        },
      ),
    },
    files: {
      close: vi.fn(async (): Promise<Result<void>> => ok(undefined)),
      location: vi.fn(locations),
      publish: vi.fn(
        async (
          _assets: VerifiedBrowserAssets,
          _desktop: typeof desktop,
          browsers: { kind: "chrome" | "edge"; path: string }[],
        ): Promise<Result<BrowserInstallation>> => {
          events.push("publish");
          const id = randomUUID(),
            generation: BrowserSetupGeneration = {
              id,
              createdAt: "2026-11-17T12:00:00.000Z",
              directoryIdentity: `synthetic-directory-${id}`,
              native: {
                osIdentity: "synthetic-native",
                contentHash: nativeHash,
                byteLength: native.length,
              },
              configuration: {
                osIdentity: "synthetic-config",
                contentHash: "b".repeat(64),
                byteLength: 1024,
              },
              manifest: {
                osIdentity: "synthetic-manifest",
                contentHash: "c".repeat(64),
                byteLength: 512,
              },
              desktopHash: desktop.hash,
              extensionId: developmentExtensionId,
              nativeSourceHash: assets.inventory.nativeSourceHash,
              browsers: [...new Set(browsers.map((item) => item.kind))],
            };
          const installation: BrowserInstallation = {
            generation,
            ...locations(generation),
            configuration: {
              version: 1,
              pipeName: `rewind.${id.replaceAll("-", "")}`,
              desktopPath: desktop.path,
              desktopHash: desktop.hash,
              hostHash: nativeHash,
              origins: [`chrome-extension://${developmentExtensionId}/`],
              browsers,
            },
          };
          files.set(id, structuredClone(installation));
          return ok(installation);
        },
      ),
      verify: vi.fn(
        async (
          generation: BrowserSetupGeneration,
        ): Promise<Result<BrowserInstallation>> => {
          events.push("verify");
          const found = files.get(generation.id);
          return found
            ? ok(structuredClone(found))
            : failure("INTEGRITY_FAILURE", "Synthetic files unavailable.");
        },
      ),
    },
    assets: vi.fn(async () => ok(assets)),
    desktop: vi.fn(async () => ok({ ...desktop })),
    browsers: [
      { kind: "chrome" as const, path: "C:\\SyntheticFixture\\chrome.exe" },
      { kind: "edge" as const, path: "C:\\SyntheticFixture\\msedge.exe" },
    ],
    quiesce: vi.fn(async (): Promise<Result<void>> => {
      events.push("quiesce");
      return ok(undefined);
    }),
    registry: {
      inspect: vi.fn(async (kind: "chrome" | "edge", manifest: string) =>
        ok({
          state:
            registrations[kind] === manifest
              ? ("registered" as const)
              : registrations[kind]
                ? ("conflict" as const)
                : ("absent" as const),
          registeredViews: registrations[kind] === manifest ? 2 : 0,
        }),
      ),
      install: vi.fn(
        async (
          kind: "chrome" | "edge",
          manifest: string,
          previous: string | null,
        ): Promise<
          Result<{ state: "registered"; registeredViews: number }>
        > => {
          events.push(`install:${kind}`);
          expect(state.pending?.operation).toBe("install");
          if (
            registrations[kind] !== null &&
            registrations[kind] !== previous &&
            !(previous && registrations[kind] === manifest)
          )
            return failure("CONFLICT", "Synthetic foreign registration.");
          registrations[kind] = manifest;
          return ok({ state: "registered", registeredViews: 2 });
        },
      ),
      remove: vi.fn(
        async (
          kind: "chrome" | "edge",
          manifest: string,
        ): Promise<Result<{ state: "absent"; registeredViews: number }>> => {
          events.push(`remove:${kind}`);
          expect(state.pending?.operation).toBe("remove");
          if (registrations[kind] !== null && registrations[kind] !== manifest)
            return failure("CONFLICT", "Synthetic foreign registration.");
          registrations[kind] = null;
          return ok({ state: "absent", registeredViews: 0 });
        },
      ),
    },
  };
  return {
    options,
    events,
    files,
    registrations,
    manager: new BrowserSetupManager(options),
    state: () => structuredClone(state),
  };
}

it("requires explicit confirmation and leaves fresh startup passive", async () => {
  const f = fixture();
  expect((await f.manager.install(false, ["chrome"])).ok).toBe(false);
  expect((await f.manager.remove(false, "chrome")).ok).toBe(false);
  expect((await f.manager.repair(false)).ok).toBe(false);
  expect(await f.manager.load()).toEqual(ok(null));
  expect(f.events).toEqual([]);
  expect(f.options.assets).not.toHaveBeenCalled();
  expect(f.options.store.write).not.toHaveBeenCalled();
});
it("drains before publication, durably prepares before registration and reports completion only after the final save", async () => {
  const f = fixture(),
    result = await f.manager.install(true, ["chrome", "edge"]);
  expect(result.ok).toBe(true);
  expect(f.state().pending).toBeNull();
  expect(f.state().registrations.chrome).toBe(f.state().registrations.edge);
  expect(f.events).toEqual([
    "quiesce",
    "publish",
    "journal:pending",
    "verify",
    "install:chrome",
    "install:edge",
    "journal:complete",
  ]);
  expect(f.options.registry.install.mock.calls[0]![2]).toBeNull();
  expect((await f.manager.load()).ok).toBe(true);
  expect(Object.keys(f.state()).sort()).toEqual([
    "generations",
    "pending",
    "registrations",
    "revision",
    "version",
  ]);
});
it("aborts before publication on unconfirmed quiescence and before registration on a failed prepared save", async () => {
  const f = fixture();
  f.options.quiesce.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic drain failure."),
  );
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(false);
  expect(f.options.files.publish).not.toHaveBeenCalled();
  f.options.store.write.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic persistence failure."),
  );
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(false);
  expect(f.options.registry.install).not.toHaveBeenCalled();
  expect(f.state().revision).toBe(0);
});
it("keeps partial registration pending across restart and repairs only on explicit confirmation", async () => {
  const f = fixture(),
    normal = f.options.registry.install.getMockImplementation()!;
  f.options.registry.install.mockImplementation(
    async (kind, manifest, previous) =>
      kind === "edge"
        ? failure("UNAVAILABLE", "Synthetic interrupted registration.")
        : normal(kind, manifest, previous),
  );
  expect((await f.manager.install(true, ["chrome", "edge"])).ok).toBe(false);
  const pending = f.state();
  expect(pending.pending?.operation).toBe("install");
  expect(pending.registrations).toEqual({ chrome: null, edge: null });
  await f.manager.close();
  f.options.registry.install.mockImplementation(normal);
  const restarted = new BrowserSetupManager(f.options),
    count = f.options.registry.install.mock.calls.length;
  expect((await restarted.load()).ok).toBe(false);
  expect(f.options.registry.install).toHaveBeenCalledTimes(count);
  expect((await restarted.repair(false)).ok).toBe(false);
  expect((await restarted.repair(true)).ok).toBe(true);
  expect(f.options.files.publish).toHaveBeenCalledTimes(1);
  expect(f.state().pending).toBeNull();
  expect((await restarted.load()).ok).toBe(true);
});
it("preserves prepared ownership when final persistence fails and reuses it on explicit repair", async () => {
  const f = fixture(),
    normal = f.options.store.write.getMockImplementation()!;
  f.options.store.write.mockImplementation(async (revision, next) =>
    !next.pending
      ? failure("UNAVAILABLE", "Synthetic completion failure.")
      : normal(revision, next),
  );
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(false);
  expect(f.registrations.chrome).not.toBeNull();
  expect(f.state().pending).not.toBeNull();
  f.options.store.write.mockImplementation(normal);
  expect((await f.manager.repair(true)).ok).toBe(true);
  expect(f.state().pending).toBeNull();
  expect(f.options.files.publish).toHaveBeenCalledTimes(1);
});
it("removes a broken installation using durable ownership without opening or executing its old files", async () => {
  const f = fixture();
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(true);
  f.options.files.verify.mockClear();
  f.files.clear();
  expect((await f.manager.remove(true, "chrome")).ok).toBe(true);
  expect(f.options.files.verify).not.toHaveBeenCalled();
  expect(f.registrations.chrome).toBeNull();
  expect(f.state().generations).toHaveLength(1);
});
it("rejects foreign registrations during removal and keeps the repair intent", async () => {
  const f = fixture();
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(true);
  f.registrations.chrome = "C:\\SyntheticForeignOwner\\host.json";
  expect((await f.manager.remove(true, "chrome")).ok).toBe(false);
  expect(f.registrations.chrome).toBe("C:\\SyntheticForeignOwner\\host.json");
  expect(f.state().pending?.operation).toBe("remove");
});
it("requires shared-generation updates and filters an unregistered browser out of passive broker authority", async () => {
  const f = fixture();
  expect((await f.manager.install(true, ["chrome", "edge"])).ok).toBe(true);
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(false);
  expect(f.options.files.publish).toHaveBeenCalledTimes(1);
  expect((await f.manager.remove(true, "chrome")).ok).toBe(true);
  const loaded = await f.manager.load();
  expect(loaded.ok).toBe(true);
  if (!loaded.ok || !loaded.value) return;
  expect(loaded.value.configuration.browsers.map((item) => item.kind)).toEqual([
    "edge",
  ]);
});
it("requires explicit update when build or registration proof changes, with no automatic repair", async () => {
  const f = fixture();
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(true);
  const count = f.options.store.write.mock.calls.length;
  f.options.desktop.mockResolvedValueOnce(
    ok({ path: "C:\\SyntheticFixture\\Rewind.exe", hash: "e".repeat(64) }),
  );
  expect((await f.manager.load()).ok).toBe(false);
  expect(f.options.store.write).toHaveBeenCalledTimes(count);
  f.registrations.chrome = null;
  expect((await f.manager.load()).ok).toBe(false);
  expect(f.options.registry.install).toHaveBeenCalledTimes(1);
});
it("accepts another compilation of the same native sources while rejecting a changed source/build fingerprint", async () => {
  const f = fixture();
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(true);
  const original = await f.options.assets();
  if (!original.ok) throw new Error("SYNTHETIC_ASSET_MISSING");
  f.options.assets.mockResolvedValueOnce(
    ok({
      ...original.value,
      inventory: {
        ...original.value.inventory,
        native: { ...original.value.inventory.native, sha256: "f".repeat(64) },
      },
    }),
  );
  expect((await f.manager.load()).ok).toBe(true);
  f.options.assets.mockResolvedValueOnce(
    ok({
      ...original.value,
      inventory: {
        ...original.value.inventory,
        nativeSourceHash: "f".repeat(64),
      },
    }),
  );
  expect((await f.manager.load()).ok).toBe(false);
  expect(f.options.files.publish).toHaveBeenCalledTimes(1);
});
it("close waits for in-flight registry work and prevents later mutations", async () => {
  const f = fixture(),
    wait = deferred<Result<{ state: "registered"; registeredViews: number }>>();
  f.options.registry.install.mockImplementationOnce(() => wait.promise);
  const installing = f.manager.install(true, ["chrome", "edge"]);
  await vi.waitFor(() =>
    expect(f.options.registry.install).toHaveBeenCalledTimes(1),
  );
  let closed = false;
  const closing = f.manager.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(false);
  wait.resolve(ok({ state: "registered", registeredViews: 2 }));
  expect((await installing).ok).toBe(false);
  await closing;
  expect(f.options.registry.install).toHaveBeenCalledTimes(1);
  expect(f.state().pending).not.toBeNull();
});
it("rejects delayed startup proof after a newer setup operation", async () => {
  const f = fixture();
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(true);
  const previous = [...f.files.values()][0]!,
    wait = deferred<Result<BrowserInstallation>>();
  f.options.files.verify.mockImplementationOnce(() => wait.promise);
  const loading = f.manager.load();
  await vi.waitFor(() =>
    expect(f.options.files.verify).toHaveBeenCalledTimes(2),
  );
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(true);
  wait.resolve(ok(previous));
  expect((await loading).ok).toBe(false);
});
it("does not acknowledge shutdown while installation helper exit is unconfirmed, and permits a later stop retry", async () => {
  const f = fixture();
  f.options.files.close.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic helper exit not observed."),
  );
  expect((await f.manager.close()).ok).toBe(false);
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(false);
  expect((await f.manager.close()).ok).toBe(true);
  expect(f.options.files.publish).not.toHaveBeenCalled();
  expect(f.options.registry.install).not.toHaveBeenCalled();
});
it("rejects unavailable selections and invalid ownership before setup changes", async () => {
  const f = fixture();
  f.options.browsers.splice(0, 1);
  expect((await f.manager.install(true, ["chrome"])).ok).toBe(false);
  expect(f.events).toEqual([]);
  f.options.store.read.mockResolvedValueOnce(
    ok({
      ...createBrowserSetupJournal(),
      registrations: { chrome: randomUUID(), edge: null },
    }),
  );
  expect((await f.manager.install(true, ["edge"])).ok).toBe(false);
  expect(f.events).toEqual([]);
});
