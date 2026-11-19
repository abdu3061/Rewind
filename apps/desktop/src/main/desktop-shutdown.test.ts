import { expect, it, vi } from "vitest";
import { failure, type Result } from "@rewind/contracts";
import { shutdownDesktop } from "./desktop-shutdown";

it("revokes/drains the worker while a native prompt remains pending and requires both acknowledgements", async () => {
  let finish!: (result: Result<void>) => void;
  const closePrompt = vi.fn(
    () =>
      new Promise<Result<void>>((resolve) => {
        finish = resolve;
      }),
  );
  const shutdownWorker = vi.fn(async () => ({
    ok: true as const,
    value: undefined,
  }));
  let settled = false;
  const result = shutdownDesktop({ closePrompt, shutdownWorker }).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(shutdownWorker).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  finish(failure("UNAVAILABLE", "Synthetic prompt did not close"));
  expect(await result).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE" },
  });
});
it("still stops the worker when native close throws and sanitizes the failure", async () => {
  const shutdownWorker = vi.fn(async () => ({
    ok: true as const,
    value: undefined,
  }));
  const result = await shutdownDesktop({
    closePrompt: () => {
      throw new Error("synthetic private detail");
    },
    shutdownWorker,
  });
  expect(shutdownWorker).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ ok: false });
  expect(JSON.stringify(result)).not.toContain("synthetic private detail");
});
it("reports success only after prompt and worker both close, preserving retry after failure", async () => {
  const closePrompt = vi.fn(async () => ({
    ok: true as const,
    value: undefined,
  }));
  const shutdownWorker = vi
    .fn<() => Promise<Result<void>>>()
    .mockResolvedValueOnce(failure("UNAVAILABLE", "Synthetic worker failure"))
    .mockResolvedValueOnce({ ok: true, value: undefined });
  expect(await shutdownDesktop({ closePrompt, shutdownWorker })).toMatchObject({
    ok: false,
  });
  expect(await shutdownDesktop({ closePrompt, shutdownWorker })).toEqual({
    ok: true,
    value: undefined,
  });
  expect(closePrompt).toHaveBeenCalledTimes(2);
});
