import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentPreviewLimits,
  workerCommandSchema,
  type DocumentParseRequest,
  type DocumentText,
} from "@rewind/contracts";
import { DocumentProcess, type DocumentGuard } from "./document-process";

const available: DocumentText = {
  state: "available",
  format: "docx",
  text: "<img src=x>",
  truncated: false,
  pagesRead: null,
  totalPages: null,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
class Child extends EventEmitter {
  pid: number | undefined = 123;
  autoExit = true;
  message: DocumentParseRequest | null = null;
  originalTransport: DocumentParseRequest | null = null;
  postMessage = vi.fn((value: DocumentParseRequest) => {
    this.originalTransport = value;
    this.message = structuredClone(value);
  });
  kill = vi.fn(() => {
    if (this.autoExit) queueMicrotask(() => this.emit("exit", 1));
    return true;
  });
  reply(result: unknown = available, id = this.message!.id): void {
    this.emit("message", { version: 1, type: "parsed", id, result });
  }
}
function setup() {
  const child = new Child(),
    exited = deferred<void>();
  let autoClose = true,
    lost = () => {};
  const guard: DocumentGuard = {
    closed: exited.promise,
    close: vi.fn(() => {
      if (autoClose) exited.resolve();
    }),
  };
  const admit = vi.fn(
    async (_pid: number, _signal: AbortSignal, loss: () => void) => {
      lost = loss;
      return guard as DocumentGuard | null;
    },
  );
  const spawn = vi.fn(() => child);
  const service = new DocumentProcess({
    spawn,
    admit,
    deadlineMs: 100,
    exitTimeoutMs: 50,
  });
  return {
    service,
    child,
    guard,
    admit,
    spawn,
    guardExit: () => exited.resolve(),
    loseGuard: () => {
      lost();
      exited.resolve();
    },
    holdGuard: () => {
      autoClose = false;
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("document process supervision", () => {
  it("an unrelated or completed owner cannot stop the currently admitted child", async () => {
    const s = setup(),
      old = new AbortController(),
      current = new AbortController();
    const result = s.service.extract("docx", Uint8Array.of(1), current.signal);
    s.child.emit("spawn");
    await tick();
    expect(await s.service.stop(old.signal)).toBe(true);
    expect(s.child.kill).not.toHaveBeenCalled();
    expect(s.service.busy).toBe(true);
    const stopped = s.service.stop(current.signal);
    await tick();
    expect(await stopped).toBe(true);
    expect(await result).toMatchObject({ reason: "cancelled" });
  });
  it("sends owned bytes only after native admission and publishes only after both observed exits", async () => {
    const s = setup(),
      source = Uint8Array.of(1, 2, 3),
      admitted = deferred<DocumentGuard | null>();
    s.admit.mockImplementationOnce(() => admitted.promise);
    s.child.autoExit = false;
    s.holdGuard();
    let finished = false;
    const result = s.service.extract("docx", source).then((value) => {
      finished = true;
      return value;
    });
    s.child.emit("spawn");
    await tick();
    expect(s.child.postMessage).not.toHaveBeenCalled();
    admitted.resolve(s.guard);
    await tick();
    expect(s.child.message?.bytes).toEqual(source);
    expect(s.child.originalTransport?.bytes.every((value) => value === 0)).toBe(
      true,
    );
    expect(source).toEqual(Uint8Array.of(1, 2, 3));
    s.child.reply();
    await tick();
    expect(finished).toBe(false);
    expect(s.service.busy).toBe(true);
    s.child.emit("exit", 0);
    await tick();
    expect(finished).toBe(false);
    s.guardExit();
    await tick();
    expect(await result).toEqual(available);
    expect(s.service.busy).toBe(false);
  });
  it("does not expose bytes if native resource admission fails", async () => {
    const s = setup();
    s.admit.mockResolvedValueOnce(null);
    const result = s.service.extract("docx", Uint8Array.of(1));
    s.child.emit("spawn");
    await tick();
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "unavailable",
    });
    expect(s.child.postMessage).not.toHaveBeenCalled();
    expect(s.service.busy).toBe(false);
  });
  it.each(["timeout", "abort", "guard loss"] as const)(
    "terminates and observes exit after %s",
    async (mode) => {
      const s = setup(),
        abort = new AbortController();
      const result = s.service.extract("docx", Uint8Array.of(1), abort.signal);
      s.child.emit("spawn");
      await tick();
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(100);
      else if (mode === "abort") abort.abort();
      else s.loseGuard();
      await tick();
      expect(await result).toMatchObject({
        state: "unavailable",
        reason:
          mode === "guard loss"
            ? "unavailable"
            : mode === "abort"
              ? "cancelled"
              : "timeout",
      });
      expect(s.child.kill).toHaveBeenCalled();
      expect(s.service.busy).toBe(false);
    },
  );
  it("keeps a surviving child busy, refuses overlapping work and allows retry only after real exit", async () => {
    const s = setup();
    s.child.autoExit = false;
    const result = s.service.extract("docx", Uint8Array.of(1));
    s.child.emit("spawn");
    await tick();
    s.child.reply();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "unavailable",
    });
    expect(s.service.busy).toBe(true);
    expect(await s.service.extract("docx", Uint8Array.of(2))).toMatchObject({
      state: "unavailable",
    });
    const stopped = s.service.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(await stopped).toBe(false);
    expect(s.spawn).toHaveBeenCalledTimes(1);
    s.child.emit("exit", 1);
    await tick();
    expect(s.service.busy).toBe(false);
    expect(await s.service.close()).toBe(true);
    expect(await s.service.extract("docx", Uint8Array.of(3))).toMatchObject({
      state: "unavailable",
    });
  });
  it("tracks an admission that settles after cancellation until the helper actually exits", async () => {
    const s = setup(),
      admitted = deferred<DocumentGuard | null>(),
      abort = new AbortController();
    s.holdGuard();
    s.admit.mockImplementationOnce(() => admitted.promise);
    const result = s.service.extract("docx", Uint8Array.of(1), abort.signal);
    s.child.emit("spawn");
    await tick();
    abort.abort();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ state: "unavailable" });
    expect(s.service.busy).toBe(true);
    admitted.resolve(s.guard);
    await tick();
    expect(s.guard.close).toHaveBeenCalled();
    expect(s.child.postMessage).not.toHaveBeenCalled();
    expect(s.service.busy).toBe(true);
    s.guardExit();
    await tick();
    expect(s.service.busy).toBe(false);
  });
  it("fences cancellation after a reply but before observed process closure", async () => {
    const s = setup();
    s.child.autoExit = false;
    const result = s.service.extract("docx", Uint8Array.of(1));
    s.child.emit("spawn");
    await tick();
    s.child.reply();
    await tick();
    const stopped = s.service.stop();
    s.child.emit("exit", 0);
    await tick();
    expect(await stopped).toBe(true);
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "cancelled",
    });
  });
  it.each([
    "wrong id",
    "wrong format",
    "oversize",
    "inconsistent pages",
    "malformed",
  ])("refuses %s replies", async (mode) => {
    const s = setup(),
      result = s.service.extract("docx", Uint8Array.of(1));
    s.child.emit("spawn");
    await tick();
    if (mode === "wrong id")
      s.child.reply(available, "00000000-0000-4000-8000-000000000001");
    else if (mode === "wrong format")
      s.child.reply({
        state: "unavailable",
        format: "pdf",
        reason: "malformed",
      });
    else if (mode === "oversize")
      s.child.reply({
        ...available,
        text: "x".repeat(documentPreviewLimits.textBytes + 1),
      });
    else if (mode === "inconsistent pages")
      s.child.reply({ ...available, pagesRead: 1 });
    else s.child.emit("message", { privatePath: "must not be a reply" });
    await tick();
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "unavailable",
    });
  });
  it("refuses a premature reply before admission", async () => {
    const s = setup(),
      result = s.service.extract("docx", Uint8Array.of(1));
    s.child.reply(available, "00000000-0000-4000-8000-000000000001");
    await tick();
    expect(await result).toMatchObject({ state: "unavailable" });
    expect(s.admit).not.toHaveBeenCalled();
  });
  it("handles a child that never spawns and rejects unsupported private public commands", async () => {
    const s = setup(),
      result = s.service.extract("docx", Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({
      state: "unavailable",
      reason: "timeout",
    });
    expect(s.admit).not.toHaveBeenCalled();
    expect(
      workerCommandSchema.safeParse({
        kind: "parse",
        format: "docx",
        bytes: Uint8Array.of(1),
      }).success,
    ).toBe(false);
    expect(
      await s.service.extract(
        "pdf",
        new Uint8Array(documentPreviewLimits.inputBytes + 1),
      ),
    ).toMatchObject({ state: "unavailable", reason: "limit" });
  });
});
