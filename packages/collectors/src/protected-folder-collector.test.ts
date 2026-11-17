import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  failure,
  type CollectorContext,
  type ProtectedFileAccess,
  type ProtectedFolder,
  type Result,
  type SnapshotCapture,
} from "@rewind/contracts";
import { ProtectedFolderCollector } from "./protected-folder-collector";

const collectors: ProtectedFolderCollector[] = [];
afterEach(async () => {
  for (const collector of collectors.splice(0)) await collector.stop();
  vi.restoreAllMocks();
});
const ok = async (): Promise<Result<void>> => ({ ok: true, value: undefined });
function fixture() {
  const folder: ProtectedFolder = {
    id: randomUUID(),
    absolutePath: "C:\\synthetic",
    selectedAt: new Date().toISOString(),
    osIdentity: "synthetic:root",
  };
  let text = "first",
    stamp = "1";
  const read = vi.fn<ProtectedFileAccess["read"]>(async () => ({
    ok: true,
    value: {
      bytes: new Uint8Array(Buffer.from(text)),
      osIdentity: "synthetic:file",
    },
  }));
  const close = vi.fn(ok);
  const bindings = new Map<string, string>(); // Synthetic persistence port, never a production fallback.
  const access: ProtectedFileAccess = {
    validateFolder: async () => ({
      ok: true,
      value: {
        absolutePath: folder.absolutePath,
        osIdentity: folder.osIdentity,
      },
    }),
    list: async () => ({
      ok: true,
      value: {
        paths: ["source.txt", "unsupported.exe"],
        stamps: [stamp, "static"],
        overflow: false,
      },
    }),
    read,
    close,
  };
  const collector = new ProtectedFolderCollector({
    getFolders: async () => ({ ok: true, value: [folder] }),
    resolveFileId: async (_folderId, relative) => ({
      ok: true,
      value: bindings.get(relative) ?? null,
    }),
    createAccess: () => access,
    intervalMs: 60000,
  });
  collectors.push(collector);
  const captures: SnapshotCapture[] = [];
  const context: CollectorContext = {
    sessionId: randomUUID(),
    generationId: randomUUID(),
    settings: {
      ...createDefaultSettings(),
      folderCollectionConsent: true,
      protectedFolderIds: [folder.id],
    },
    emit: vi.fn(async (events) => {
      for (const event of events)
        if (event.type === "file-change") {
          const captured = await collector.captureFor(event, context.settings);
          if (!captured.ok) return captured;
          bindings.set(
            captured.value.binding.relativePath,
            captured.value.file.id,
          );
          captures.push({
            ...captured.value,
            bytes: new Uint8Array(captured.value.bytes),
          });
        }
      return ok();
    }),
  };
  return {
    collector,
    folder,
    context,
    access,
    read,
    close,
    captures,
    change: (value: string) => {
      text = value;
      stamp = String(Number(stamp) + 1);
    },
  };
}
it("captures a baseline and saved changes with stable path IDs, deduplication and unsupported-file disclosure", async () => {
  const f = fixture();
  await f.collector.start(f.context);
  expect((await f.collector.poll()).ok).toBe(true);
  expect(f.captures).toHaveLength(1);
  expect(f.context.emit).toHaveBeenCalledWith([
    expect.objectContaining({
      payload: expect.objectContaining({ change: "captured" }),
    }),
  ]);
  expect(Buffer.from(f.captures[0]!.bytes).toString()).toBe("first");
  expect(f.collector.status()).toMatchObject({
    state: "watching",
    captured: 1,
    skipped: 1,
  });
  await f.collector.poll();
  expect(f.read).toHaveBeenCalledTimes(1);
  f.change("second");
  await f.collector.poll();
  expect(f.captures).toHaveLength(2);
  expect(f.captures[1]!.file.id).toBe(f.captures[0]!.file.id);
  expect(Buffer.from(f.captures[1]!.bytes).toString()).toBe("second");
  const future = Date.now() + 61000;
  vi.spyOn(Date, "now").mockReturnValue(future);
  await f.collector.poll();
  expect(f.read).toHaveBeenCalledTimes(3);
  expect(f.captures).toHaveLength(2);
});
it("waits for an in-flight read, wipes its stale bytes and emits no capture after stop", async () => {
  const f = fixture();
  let release!: (
    value: Awaited<ReturnType<ProtectedFileAccess["read"]>>,
  ) => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  f.read.mockImplementationOnce(() => {
    enter();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await f.collector.start(f.context);
  const work = f.collector.poll();
  await entered;
  let stopped = false;
  const stop = f.collector.stop().then((result) => {
    stopped = true;
    return result;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  const bytes = new Uint8Array([1, 2, 3]);
  release({ ok: true, value: { bytes, osIdentity: "synthetic:file" } });
  expect((await work).ok).toBe(false);
  expect((await stop).ok).toBe(true);
  expect([...bytes]).toEqual([0, 0, 0]);
  expect(f.captures).toHaveLength(0);
  expect((await f.collector.poll()).ok).toBe(false);
});
it("keeps distinct Unicode names separate and periodically verifies unchanged current bytes before retention expires", async () => {
  const f = fixture();
  f.access.list = async () => ({
    ok: true,
    value: {
      paths: ["\u0130.txt", "i\u0307.txt"],
      stamps: ["1", "2"],
      overflow: false,
    },
  });
  f.context.settings = { ...f.context.settings, retentionHours: 1 };
  await f.collector.start(f.context);
  await f.collector.poll();
  expect(f.captures).toHaveLength(2);
  expect(f.captures[0]!.file.displayName.toLowerCase()).toBe(
    f.captures[1]!.file.displayName.toLowerCase(),
  );
  expect(f.captures[0]!.file.id).not.toBe(f.captures[1]!.file.id);
  const future = Date.now() + 31 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(future);
  await f.collector.poll();
  expect(f.captures).toHaveLength(4);
  expect(f.captures[2]!.file.id).toBe(f.captures[0]!.file.id);
  expect(f.captures[3]!.file.id).toBe(f.captures[1]!.file.id);
});
it("retains a failed-close handle, coalesces stops and requires an actual successful retry", async () => {
  const f = fixture();
  await f.collector.start(f.context);
  f.close.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic close failure"),
  );
  const results = await Promise.all([f.collector.stop(), f.collector.stop()]);
  expect(results.every((result) => !result.ok)).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect((await f.collector.stop()).ok).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(2);
});
it("stops reading after a failed publication instead of continuing behind lifecycle backlog", async () => {
  const f = fixture();
  f.context.emit = async () => failure("UNAVAILABLE", "Synthetic full disk");
  await f.collector.start(f.context);
  expect((await f.collector.poll()).ok).toBe(false);
  expect(f.collector.status()).toMatchObject({
    state: "unavailable",
    failed: 1,
  });
  expect(f.close).toHaveBeenCalledOnce();
  expect((await f.collector.poll()).ok).toBe(false);
  expect(f.read).toHaveBeenCalledTimes(1);
});
