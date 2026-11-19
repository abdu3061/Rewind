import {
  constants,
  createPublicKey,
  generateKeyPairSync,
  publicEncrypt,
  randomUUID,
} from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import {
  failure,
  type AssistantCredential,
  type AssistantCredentialChallenge,
  type Result,
} from "@rewind/contracts";
import { AssistantCredentials } from "./assistant-credentials";

const secret = "Synthetic_Private_Credential_9201",
  at = "2026-11-18T10:00:00.000Z";
// Lifecycle/clock cases still encrypt and decrypt with real, distinct 4096-bit keys.
// Generate their synthetic recipients once; random prime generation is not their subject.
// The first acceptance case below deliberately keeps the production generator.
const recipients: ReturnType<typeof generateKeyPairSync>[] = [];
let recipient = 0;
beforeAll(() => {
  for (let i = 0; i < 2; i++)
    recipients.push(
      generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicExponent: 65537,
      }),
    );
}, 30000);
function seal(
  challenge: AssistantCredentialChallenge,
  value: unknown = { id: challenge.id, apiKey: secret },
) {
  const key = createPublicKey({
    key: {
      kty: "RSA",
      n: Buffer.from(challenge.modulus, "base64").toString("base64url"),
      e: Buffer.from(challenge.exponent, "base64").toString("base64url"),
    },
    format: "jwk",
  });
  return {
    id: challenge.id,
    sealed: publicEncrypt(
      { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(JSON.stringify(value)),
    ).toString("base64"),
  };
}
function fixture(
  createPair:
    | ConstructorParameters<typeof AssistantCredentials>[0]["createPair"]
    | null = async () => recipients[recipient++ % recipients.length]!,
) {
  let clock = at,
    ticks = 0,
    cloud = true;
  const state: AssistantCredential = {
    revision: 0,
    apiKey: null,
    updatedAt: null,
  };
  const read = vi.fn(async (): Promise<Result<AssistantCredential>> => ({
    ok: true,
    value: { ...state },
  }));
  const write = vi.fn(
    async (
      expected: number,
      apiKey: string | null,
      updatedAt: string,
    ): Promise<Result<void>> => {
      if (state.revision !== expected)
        return failure("CONFLICT", "Synthetic stale credential");
      state.revision++;
      state.apiKey = apiKey;
      state.updatedAt = updatedAt;
      return { ok: true, value: undefined };
    },
  );
  const quiesce = vi.fn(async (): Promise<Result<void>> => {
    cloud = false;
    return { ok: true, value: undefined };
  });
  const service = new AssistantCredentials({
    store: { read, write },
    quiesce,
    now: () => clock,
    monotonicNow: () => ticks,
    ...(createPair ? { createPair } : {}),
  });
  return {
    service,
    state,
    read,
    write,
    quiesce,
    cloud: () => cloud,
    advanceWall: () => {
      clock = "2026-11-18T10:03:00.000Z";
    },
    advanceTicks: () => {
      ticks = 180000;
    },
    async prepare() {
      const result = await service.prepare(true);
      if (!result.ok)
        throw new Error("SYNTHETIC_CREDENTIAL_PREPARATION_FAILED");
      return result.value;
    },
  };
}
it("issues only a public RSA challenge, accepts one sealed native secret and never grants cloud use", async () => {
  const f = fixture(null),
    challenge = await f.prepare(),
    packet = seal(challenge);
  expect(challenge).toMatchObject({ exponent: "AQAB" });
  expect(challenge.modulus).toHaveLength(684);
  expect(JSON.stringify(challenge)).not.toContain(secret);
  expect(JSON.stringify(packet)).not.toContain(secret);
  expect(f.cloud()).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.service.busy).toBe(true);
  challenge.expiresAt = "2020-01-01T00:00:00.000Z";
  expect(await f.service.accept(packet, true)).toEqual({
    ok: true,
    value: true,
  });
  expect(f.state).toEqual({ revision: 1, apiKey: secret, updatedAt: at });
  expect(f.cloud()).toBe(false);
  expect(await f.service.accept(packet, true)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(f.write).toHaveBeenCalledTimes(1);
  expect((await f.service.close()).ok).toBe(true);
}, 10000);
it("requires confirmation and permits cancellation without storing or revealing a secret", async () => {
  const f = fixture();
  expect((await f.service.prepare(false as true)).ok).toBe(false);
  expect(f.quiesce).not.toHaveBeenCalled();
  const challenge = await f.prepare(),
    packet = seal(challenge);
  expect((await f.service.accept(packet, false as true)).ok).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.service.cancel(challenge.id).ok).toBe(true);
  expect((await f.service.accept(packet, true)).ok).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  expect((await f.service.close()).ok).toBe(true);
}, 10000);
for (const clock of ["wall", "monotonic"] as const)
  it(`expires a sealed credential using ${clock} time`, async () => {
    const f = fixture(),
      challenge = await f.prepare(),
      packet = seal(challenge);
    if (clock === "wall") f.advanceWall();
    else f.advanceTicks();
    expect((await f.service.accept(packet, true)).ok).toBe(false);
    expect(f.write).not.toHaveBeenCalled();
    await f.service.close();
  }, 10000);
it("refuses malformed, wrong-review and invalid-secret payloads without leaking decryption details", async () => {
  const f = fixture();
  let challenge = await f.prepare();
  const wrongId = seal(challenge, { id: randomUUID(), apiKey: secret });
  const failed = await f.service.accept(wrongId, true);
  expect(failed.ok).toBe(false);
  expect(JSON.stringify(failed)).not.toContain(secret);
  challenge = await f.prepare();
  expect(
    (
      await f.service.accept(
        seal(challenge, {
          id: challenge.id,
          apiKey: "Invalid key with spaces",
        }),
        true,
      )
    ).ok,
  ).toBe(false);
  challenge = await f.prepare();
  expect(
    (
      await f.service.accept(
        { id: challenge.id, sealed: Buffer.alloc(512, 42).toString("base64") },
        true,
      )
    ).ok,
  ).toBe(false);
  expect(f.write).not.toHaveBeenCalled();
  await f.service.close();
}, 15000);
it("rejects stale recipients and credential revisions while preserving existing state", async () => {
  const f = fixture(),
    first = await f.prepare(),
    oldPacket = seal(first),
    second = await f.prepare();
  expect(second.id).not.toBe(first.id);
  expect(second.modulus).not.toBe(first.modulus);
  expect(
    (await f.service.accept({ ...oldPacket, id: second.id }, true)).ok,
  ).toBe(false);
  const third = await f.prepare();
  f.state.revision = 1;
  f.state.apiKey = "Different_Synthetic_Credential_9201";
  f.state.updatedAt = at;
  expect(await f.service.accept(seal(third), true)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(f.state.apiKey).toBe("Different_Synthetic_Credential_9201");
  await f.service.close();
}, 15000);
it("requires observed cloud quiescence and reports thrown persistence errors without exposing a secret", async () => {
  const f = fixture();
  f.quiesce.mockResolvedValueOnce(
    failure("UNAVAILABLE", "Synthetic cloud request pending"),
  );
  expect((await f.service.prepare(true)).ok).toBe(false);
  expect(f.read).not.toHaveBeenCalled();
  const challenge = await f.prepare();
  f.write.mockImplementationOnce(async () => {
    throw new Error(secret);
  });
  const result = await f.service.accept(seal(challenge), true);
  expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(f.state.apiKey).toBeNull();
  await f.service.close();
}, 10000);
it("forgets only after explicit confirmation and revocation without re-enabling cloud", async () => {
  const f = fixture(),
    challenge = await f.prepare();
  await f.service.accept(seal(challenge), true);
  expect((await f.service.forget(false as true)).ok).toBe(false);
  expect(f.state.apiKey).toBe(secret);
  expect(await f.service.forget(true)).toEqual({ ok: true, value: true });
  expect(f.state).toEqual({ revision: 2, apiKey: null, updatedAt: at });
  expect(f.cloud()).toBe(false);
  await f.service.close();
}, 10000);
it("fences delayed recipient creation and retains unobserved shutdown for retry", async () => {
  const pair = recipients[0]!;
  let finish: (value: typeof pair) => void = () => {};
  const createPair = vi.fn(
      () =>
        new Promise<typeof pair>((resolve) => {
          finish = resolve;
        }),
    ),
    f = fixture(createPair);
  const preparing = f.service.prepare(true);
  await vi.waitFor(() => expect(createPair).toHaveBeenCalledTimes(1));
  expect((await f.service.prepare(true)).ok).toBe(false);
  expect((await f.service.forget(true)).ok).toBe(false);
  expect((await f.service.close()).ok).toBe(false);
  finish(pair);
  expect((await preparing).ok).toBe(false);
  expect((await f.service.close()).ok).toBe(true);
  expect(f.write).not.toHaveBeenCalled();
}, 10000);
