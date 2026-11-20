import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  failure,
  type FileVersion,
  type RecoveryFileEvidence,
  type RecoveryOverwriteReceipt,
  type Result,
} from "@rewind/contracts";
import { RecoveryOverwriteService } from "./recovery-overwrite-service";

function fixture() {
  let now = "2026-11-18T10:00:00.000Z",
    ticks = 0;
  const version: FileVersion = {
    id: randomUUID(),
    fileId: randomUUID(),
    sessionId: randomUUID(),
    capturedAt: now,
    contentHash: "a".repeat(64),
    byteLength: 3,
    mediaType: "text/plain",
  };
  const current: RecoveryFileEvidence = {
    osIdentity: "11111111:0000000000000001",
    contentHash: "b".repeat(64),
    byteLength: 5,
    lastWriteToken: "0000000000000001",
  };
  const buffers: Uint8Array[] = [];
  const read = vi.fn(
    async (): Promise<
      Result<{ version: FileVersion; bytes: Uint8Array; sourceLabel: string }>
    > => {
      const bytes = new Uint8Array([7, 8, 9]);
      buffers.push(bytes);
      return {
        ok: true,
        value: {
          version: { ...version },
          bytes,
          sourceLabel: "Synthetic source.txt",
        },
      };
    },
  );
  const validate = vi.fn(async () => ({
    ok: true as const,
    value: {
      directory: {
        absolutePath: "C:\\Synthetic",
        osIdentity: "11111111:0000000000000009",
      },
      name: "current.txt",
      label: "C:\\Synthetic\\current.txt",
    },
  }));
  const inspect = vi.fn(async (): Promise<Result<RecoveryFileEvidence>> => ({
    ok: true,
    value: { ...current },
  }));
  const receipt = (): RecoveryOverwriteReceipt => ({
    target: {
      ...current,
      contentHash: version.contentHash,
      byteLength: version.byteLength,
      lastWriteToken: "0000000000000002",
    },
    preserved: { ...current, osIdentity: "11111111:0000000000000002" },
  });
  const write = vi.fn(async (): Promise<Result<RecoveryOverwriteReceipt>> => ({
    ok: true,
    value: receipt(),
  }));
  const close = vi.fn(async (): Promise<Result<void>> => ({
    ok: true,
    value: undefined,
  }));
  const service = new RecoveryOverwriteService({
    newId: randomUUID,
    now: () => now,
    monotonicNow: () => ticks,
    readSnapshot: read,
    validateDestination: validate,
    writer: { inspect, overwrite: write, close },
  });
  return {
    service,
    version,
    current,
    buffers,
    read,
    validate,
    inspect,
    write,
    close,
    receipt,
    advanceWall: () => {
      now = "2026-11-18T10:06:00.000Z";
    },
    advanceTicks: () => {
      ticks += 360_000;
    },
    async prepare() {
      const p = await service.prepare(version.id, "C:\\Synthetic\\current.txt");
      if (!p.ok) throw new Error("SYNTHETIC_PROPOSAL_FAILED");
      return p.value;
    },
  };
}
it("reviews actual current evidence without writing, keeps authority immutable and confirms only once", async () => {
  const f = fixture(),
    p = await f.prepare();
  expect(p).toMatchObject({
    mode: "overwrite",
    requiresCurrentFilePreservation: true,
    currentContentHash: f.current.contentHash,
    currentByteLength: 5,
  });
  const preservationLabel = p.preservationLabel;
  expect(preservationLabel).toBe(`C:\\Synthetic\\Rewind-preserved-${p.id}.bak`);
  expect(f.write).not.toHaveBeenCalled();
  p.destinationLabel = "Tampered renderer label";
  p.preservationLabel = "Tampered preservation";
  p.currentContentHash = "c".repeat(64);
  expect(await f.service.confirm(p.id, true)).toMatchObject({
    ok: true,
    value: {
      mode: "overwrite",
      destinationLabel: "C:\\Synthetic\\current.txt",
      preservationLabel,
      preservedContentHash: f.current.contentHash,
      preservedByteLength: 5,
      contentHash: f.version.contentHash,
    },
  });
  expect(f.write).toHaveBeenCalledWith(
    {
      directory: {
        absolutePath: "C:\\Synthetic",
        osIdentity: "11111111:0000000000000009",
      },
      name: "current.txt",
      evidence: f.current,
    },
    `Rewind-preserved-${p.id}.bak`,
    expect.any(Uint8Array),
    f.version.contentHash,
  );
  expect(f.buffers.every((bytes) => bytes.every((value) => value === 0))).toBe(
    true,
  );
  expect(await f.service.confirm(p.id, true)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(f.write).toHaveBeenCalledTimes(1);
});
it("requires literal confirmation, supports cancellation and bounds pending reviews", async () => {
  const f = fixture(),
    p = await f.prepare();
  expect((await f.service.confirm(p.id, false as true)).ok).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.service.cancel(p.id).ok).toBe(true);
  expect((await f.service.confirm(p.id, true)).ok).toBe(false);
  expect(f.service.cancel("invalid").ok).toBe(false);
  for (let i = 0; i < 8; i++) await f.prepare();
  expect(
    (await f.service.prepare(f.version.id, "C:\\Synthetic\\current.txt")).ok,
  ).toBe(false);
});
for (const clock of ["wall", "monotonic"] as const)
  it(`expires a review using ${clock} time`, async () => {
    const f = fixture(),
      p = await f.prepare();
    if (clock === "wall") f.advanceWall();
    else f.advanceTicks();
    expect((await f.service.confirm(p.id, true)).ok).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
  });
it("rejects invalid or uninspectable targets and oversized preservation paths without writing", async () => {
  const f = fixture();
  expect(
    (await f.service.prepare("invalid", "C:\\Synthetic\\current.txt")).ok,
  ).toBe(false);
  f.inspect.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic locked target"),
  );
  expect(
    (await f.service.prepare(f.version.id, "C:\\Synthetic\\current.txt")).ok,
  ).toBe(false);
  f.inspect.mockResolvedValueOnce({
    ok: true,
    value: { ...f.current, osIdentity: "unverified" },
  });
  expect(
    (await f.service.prepare(f.version.id, "C:\\Synthetic\\current.txt")).ok,
  ).toBe(false);
  f.validate.mockResolvedValueOnce({
    ok: true,
    value: {
      directory: {
        absolutePath: "C:\\" + "x".repeat(220),
        osIdentity: "11111111:0000000000000009",
      },
      name: "f",
      label: "C:\\f",
    },
  });
  expect((await f.service.prepare(f.version.id, "C:\\f")).ok).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.buffers.every((bytes) => bytes.every((value) => value === 0))).toBe(
    true,
  );
});
it("rereads retained bytes and aborts a deleted or changed source before native mutation", async () => {
  const f = fixture(),
    p = await f.prepare();
  f.read.mockResolvedValueOnce(
    failure("NOT_FOUND", "Synthetic expired source"),
  );
  expect((await f.service.confirm(p.id, true)).ok).toBe(false);
  const q = await f.prepare();
  f.version.contentHash = "c".repeat(64);
  expect(await f.service.confirm(q.id, true)).toMatchObject({
    ok: false,
    error: { code: "INTEGRITY_FAILURE" },
  });
  expect(f.write).not.toHaveBeenCalled();
});
it("rechecks expiry after asynchronous source verification and consumes failed proposals", async () => {
  const f = fixture(),
    p = await f.prepare(),
    read = f.read.getMockImplementation()!;
  f.read.mockImplementationOnce(async () => {
    const r = await read();
    f.advanceTicks();
    return r;
  });
  expect((await f.service.confirm(p.id, true)).ok).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect((await f.service.confirm(p.id, true)).ok).toBe(false);
});
it("propagates failed preservation and detects inconsistent target or backup receipts", async () => {
  const f = fixture(),
    p = await f.prepare();
  f.write.mockResolvedValueOnce(failure("CONFLICT", "Synthetic backup exists"));
  expect(await f.service.confirm(p.id, true)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  const q = await f.prepare();
  f.write.mockResolvedValueOnce({
    ok: true,
    value: {
      ...f.receipt(),
      preserved: { ...f.current, contentHash: "c".repeat(64) },
    },
  });
  expect(await f.service.confirm(q.id, true)).toMatchObject({
    ok: false,
    error: { code: "INTEGRITY_FAILURE" },
  });
  const r = await f.prepare();
  f.write.mockResolvedValueOnce({
    ok: true,
    value: {
      ...f.receipt(),
      target: {
        ...f.receipt().target,
        osIdentity: "11111111:0000000000000099",
      },
    },
  });
  expect((await f.service.confirm(r.id, true)).ok).toBe(false);
});
it("fences late preparation during shutdown and observes source/native work before closing", async () => {
  const f = fixture();
  let finish: (value: Result<RecoveryFileEvidence>) => void = () => {};
  f.inspect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const preparing = f.service.prepare(
    f.version.id,
    "C:\\Synthetic\\current.txt",
  );
  await vi.waitFor(() => expect(f.inspect).toHaveBeenCalledTimes(1));
  expect(
    (await f.service.prepare(f.version.id, "C:\\Synthetic\\current.txt")).ok,
  ).toBe(false);
  let closed = false;
  const closing = f.service.close().then((r) => {
    closed = true;
    return r;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish({ ok: true, value: f.current });
  expect((await preparing).ok).toBe(false);
  expect((await closing).ok).toBe(true);
  expect(f.write).not.toHaveBeenCalled();
  expect(
    (await f.service.prepare(f.version.id, "C:\\Synthetic\\current.txt")).ok,
  ).toBe(false);
});
it("retains failed shutdown as a retryable failure", async () => {
  const f = fixture();
  f.close.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic helper pending"),
  );
  expect((await f.service.close()).ok).toBe(false);
  expect((await f.service.close()).ok).toBe(true);
});
