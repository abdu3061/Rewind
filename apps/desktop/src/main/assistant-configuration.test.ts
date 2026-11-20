import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  failure,
  type AssistantCredentialChallenge,
  type AssistantSealedCredential,
  type Result,
} from "@rewind/contracts";
import { AssistantConfiguration } from "./assistant-configuration";
import type { WorkerClient } from "./worker-client";

function fixture() {
  const challenge: AssistantCredentialChallenge = {
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    modulus: Buffer.alloc(512, 131).toString("base64"),
    exponent: "AQAB",
  };
  const sealed: AssistantSealedCredential = {
    id: challenge.id,
    sealed: Buffer.alloc(512, 71).toString("base64"),
  };
  const state = {
    generation: randomUUID(),
    configured: true,
    permission: false,
    busy: false,
    credentialPending: false,
    revision: 1,
  };
  const request = vi.fn().mockResolvedValue({ ok: true, value: true });
  request
    .mockResolvedValueOnce({ ok: true, value: challenge })
    .mockResolvedValueOnce({ ok: true, value: state });
  const native = {
    prompt: vi
      .fn<() => Promise<Result<AssistantSealedCredential | null>>>()
      .mockResolvedValue({ ok: true, value: sealed }),
    close: vi.fn(async (): Promise<Result<void>> => ({
      ok: true,
      value: undefined,
    })),
  };
  const service = new AssistantConfiguration(
    { request } as unknown as Pick<WorkerClient, "request">,
    native,
  );
  return { service, request, native, challenge, sealed, state };
}
it("routes a public challenge into native entry and only sealed bytes into the utility, then closes the private review", async () => {
  const f = fixture();
  expect(await f.service.configure()).toEqual({ ok: true, value: f.state });
  expect(f.native.prompt).toHaveBeenCalledWith(f.challenge);
  expect(f.request.mock.calls.map(([command]) => command)).toEqual([
    { kind: "assistant.credential.prepare", confirmed: true },
    { kind: "assistant.credential.accept", confirmed: true, value: f.sealed },
    { kind: "assistant.credential.cancel", id: f.challenge.id },
  ]);
  expect((await f.service.close()).ok).toBe(true);
  expect(f.native.close).toHaveBeenCalledTimes(1);
});
it("returns honest cancellation and never accepts a value when native entry is cancelled or mismatched", async () => {
  for (const value of [
    null,
    { id: randomUUID(), sealed: Buffer.alloc(512).toString("base64") },
  ]) {
    const f = fixture();
    f.native.prompt.mockResolvedValueOnce({ ok: true, value });
    f.request
      .mockReset()
      .mockResolvedValue({ ok: true, value: true })
      .mockResolvedValueOnce({ ok: true, value: f.challenge });
    const result = await f.service.configure();
    expect(result).toMatchObject(
      value === null
        ? { ok: true, value: null }
        : { ok: false, error: { code: "INTEGRITY_FAILURE" } },
    );
    expect(f.request.mock.calls.map(([command]) => command.kind)).toEqual([
      "assistant.credential.prepare",
      "assistant.credential.cancel",
    ]);
  }
});
it("rejects a concurrent configuration without replacing the active recipient", async () => {
  const f = fixture();
  let finish: (
    value: Result<AssistantSealedCredential | null>,
  ) => void = () => {};
  f.native.prompt.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.service.configure();
  await vi.waitFor(() => expect(f.native.prompt).toHaveBeenCalledTimes(1));
  expect(await f.service.configure()).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(f.request).toHaveBeenCalledTimes(1);
  finish({ ok: true, value: f.sealed });
  expect((await first).ok).toBe(true);
});
it("cancels a failed native entry and reports a failure if private review closure cannot be verified", async () => {
  const f = fixture();
  f.native.prompt.mockRejectedValueOnce(new Error("SYNTHETIC_NATIVE_FAILURE"));
  f.request
    .mockReset()
    .mockResolvedValueOnce({ ok: true, value: f.challenge })
    .mockResolvedValueOnce(failure("UNAVAILABLE", "Synthetic closure failure"));
  expect(await f.service.configure()).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE" },
  });
  expect(f.request).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "assistant.credential.cancel" }),
    expect.anything(),
  );
});
