import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  failure,
  type FileVersion,
  type RecoveryCopyReceipt,
  type Result,
} from "@rewind/contracts";
import { RecoveryCopyService } from "./recovery-copy-service";

function fixture() {
  let now = "2026-11-17T10:00:00.000Z";
  let ticks = 0;
  const version: FileVersion = {
    id: randomUUID(),
    fileId: randomUUID(),
    sessionId: randomUUID(),
    capturedAt: now,
    contentHash: "a".repeat(64),
    byteLength: 3,
    mediaType: "text/plain",
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
      directory: { absolutePath: "C:\\Synthetic", osIdentity: "1234:5678" },
      name: "copy.txt",
      label: "C:\\Synthetic\\copy.txt",
    },
  }));
  const write = vi.fn(async (): Promise<Result<RecoveryCopyReceipt>> => ({
    ok: true,
    value: {
      contentHash: version.contentHash,
      byteLength: version.byteLength,
      osIdentity: "1234:abcd",
    },
  }));
  const close = vi.fn(async (): Promise<Result<void>> => ({
    ok: true,
    value: undefined,
  }));
  const service = new RecoveryCopyService({
    newId: randomUUID,
    now: () => now,
    monotonicNow: () => ticks,
    readSnapshot: read,
    validateDestination: validate,
    writer: { createCopy: write, close },
  });
  return {
    service,
    version,
    buffers,
    read,
    validate,
    write,
    close,
    advanceTicks: () => {
      ticks += 360_000;
    },
    advance: () => {
      now = "2026-11-17T10:06:00.000Z";
    },
    async prepare() {
      const result = await service.prepare(
        version.id,
        "C:\\Synthetic\\copy.txt",
      );
      if (!result.ok) throw new Error("Synthetic proposal failed");
      return result.value;
    },
  };
}
it("reviews an immutable plan without writing and rereads the source only after single-use confirmation", async () => {
  const f = fixture(),
    proposal = await f.prepare();
  expect(f.write).not.toHaveBeenCalled();
  expect(f.buffers[0]).toEqual(new Uint8Array(3));
  proposal.destinationLabel = "Tampered renderer label";
  expect(await f.service.confirm(proposal.id, true)).toMatchObject({
    ok: true,
    value: {
      destinationLabel: "C:\\Synthetic\\copy.txt",
      contentHash: f.version.contentHash,
      fileVersionId: f.version.id,
      mode: "save-copy",
    },
  });
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.buffers.every((bytes) => bytes.every((b) => b === 0))).toBe(true);
  expect(await f.service.confirm(proposal.id, true)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});
it("requires literal confirmation, rejects expired/cancelled plans, and bounds outstanding proposals", async () => {
  const f = fixture(),
    proposal = await f.prepare();
  expect((await f.service.confirm(proposal.id, false as true)).ok).toBe(false);
  expect(f.service.cancel(proposal.id).ok).toBe(true);
  expect((await f.service.confirm(proposal.id, true)).ok).toBe(false);
  const expired = await f.prepare();
  f.advance();
  expect((await f.service.confirm(expired.id, true)).ok).toBe(false);
  for (let i = 0; i < 8; i++) await f.prepare();
  expect(
    await f.service.prepare(f.version.id, "C:\\Synthetic\\extra.txt"),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(f.write).not.toHaveBeenCalled();
});
it("aborts a deleted, corrupt or changed retained source before any destination write", async () => {
  for (const code of ["NOT_FOUND", "INTEGRITY_FAILURE"] as const) {
    const f = fixture(),
      proposal = await f.prepare();
    f.read.mockResolvedValueOnce(failure(code, "Synthetic unavailable source"));
    expect(await f.service.confirm(proposal.id, true)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(f.write).not.toHaveBeenCalled();
  }
  const f = fixture(),
    proposal = await f.prepare();
  f.version.contentHash = "b".repeat(64);
  expect((await f.service.confirm(proposal.id, true)).ok).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.buffers[1]).toEqual(new Uint8Array(3));
});
it("expires on monotonic time and checks expiry again after an asynchronous source verification", async () => {
  for (const duringRead of [false, true]) {
    const f = fixture(),
      proposal = await f.prepare();
    if (duringRead) {
      const originalRead = f.read.getMockImplementation()!;
      f.read.mockImplementationOnce(async () => {
        const value = await originalRead();
        f.advanceTicks();
        return value;
      });
    } else f.advanceTicks();
    expect(await f.service.confirm(proposal.id, true)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(f.write).not.toHaveBeenCalled();
  }
});
it("returns destination failures and never reports an unverified output as success", async () => {
  const f = fixture(),
    proposal = await f.prepare();
  f.write.mockResolvedValueOnce(
    failure("CONFLICT", "Synthetic existing target"),
  );
  expect(await f.service.confirm(proposal.id, true)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  const second = await f.prepare();
  f.write.mockResolvedValueOnce({
    ok: true,
    value: { contentHash: "b".repeat(64), byteLength: 3, osIdentity: "wrong" },
  });
  expect(await f.service.confirm(second.id, true)).toMatchObject({
    ok: false,
    error: { code: "INTEGRITY_FAILURE" },
  });
  expect(f.buffers.every((bytes) => bytes.every((b) => b === 0))).toBe(true);
});
it("drains a pending source read on shutdown, wipes its bytes and prevents a late write", async () => {
  const f = fixture(),
    proposal = await f.prepare();
  let release!: (value: Awaited<ReturnType<typeof f.read>>) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const confirmation = f.service.confirm(proposal.id, true);
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
  expect((await f.service.confirm(proposal.id, true)).ok).toBe(false);
  const closing = f.service.close(),
    bytes = new Uint8Array([7, 8, 9]);
  release({
    ok: true,
    value: { version: f.version, bytes, sourceLabel: "Synthetic" },
  });
  expect((await confirmation).ok).toBe(false);
  expect((await closing).ok).toBe(true);
  expect(bytes).toEqual(new Uint8Array(3));
  expect(f.write).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
});
it("keeps failed helper shutdown observable and permits retry", async () => {
  const f = fixture();
  f.close.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic helper still running"),
  );
  expect((await f.service.close()).ok).toBe(false);
  expect(
    (await f.service.prepare(f.version.id, "C:\\Synthetic\\copy.txt")).ok,
  ).toBe(false);
  expect((await f.service.close()).ok).toBe(true);
});
