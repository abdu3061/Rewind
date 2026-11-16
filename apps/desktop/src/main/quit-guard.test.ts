import { expect, it, vi } from "vitest";
import { failure, type Result } from "@rewind/contracts";
import { QuitGuard } from "./quit-guard";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
it("prevents and coalesces quit until cleanup acknowledges, then permits the guarded quit", async () => {
  let resolve!: (result: Result<void>) => void;
  const shutdown = vi.fn(
    () =>
      new Promise<Result<void>>((done) => {
        resolve = done;
      }),
  );
  const quit = vi.fn();
  const failed = vi.fn();
  const event = { preventDefault: vi.fn() };
  const guard = new QuitGuard({ shutdown, quit, failed });
  guard.beforeQuit(event);
  guard.beforeQuit(event);
  await turn();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(quit).not.toHaveBeenCalled();
  resolve({ ok: true, value: undefined });
  await turn();
  expect(quit).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
  guard.beforeQuit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
});
it.each(["result", "rejection"])(
  "keeps the app open on cleanup %s failure and allows retry",
  async (kind) => {
    const shutdown = vi.fn(async (): Promise<Result<void>> => ({
      ok: true,
      value: undefined,
    }));
    if (kind === "result")
      shutdown.mockResolvedValueOnce(failure("UNAVAILABLE", "Synthetic"));
    else shutdown.mockRejectedValueOnce(new Error("Synthetic"));
    const quit = vi.fn();
    const failed = vi.fn();
    const guard = new QuitGuard({ shutdown, quit, failed });
    guard.beforeQuit({ preventDefault: vi.fn() });
    await turn();
    expect(quit).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    guard.beforeQuit({ preventDefault: vi.fn() });
    await turn();
    expect(quit).toHaveBeenCalledTimes(1);
  },
);
