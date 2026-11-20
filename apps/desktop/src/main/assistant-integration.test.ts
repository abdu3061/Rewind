import {
  constants,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assistantAnswerResponseSchema,
  assistantControlResponseSchema,
  assistantCredentialChallengeResponseSchema,
  assistantReviewResponseSchema,
  createDefaultSettings,
  recordingCommandSchema,
  type ActivityEvent,
  type AssistantCredentialChallenge,
} from "@rewind/contracts";
import { SecureStorage } from "@rewind/storage";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import {
  preparePrivateDirectory,
  secureDatabaseName,
} from "@rewind/storage/key-store";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";
import { WorkerRuntime } from "./worker-runtime";

const roots: string[] = [],
  runtimes: WorkerRuntime[] = [];
const privateKey = "Synthetic_Gemini_Secret_684901";
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("REAL_NETWORK_FORBIDDEN_IN_SYNTHETIC_TEST");
    }),
  );
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0))
    expect((await runtime.shutdown()).ok).toBe(true);
  for (const root of roots.splice(0)) removeSecureFixture(root);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const reply = (parts: unknown[]) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    }),
    { headers: { "content-type": "application/json" } },
  );
const planning = (keys = ["E1"]) =>
  reply([{ functionCall: { name: "get_approved_evidence", args: { keys } } }]);
const answer = (keys = ["E1"]) =>
  reply([
    {
      text: JSON.stringify({
        text: "Only the supplied synthetic title was recorded.",
        sourceKeys: keys,
        insufficientEvidence: false,
      }),
    },
  ]);
function seal(challenge: AssistantCredentialChallenge, apiKey: string) {
  return {
    id: challenge.id,
    sealed: publicEncrypt(
      {
        key: createPublicKey({
          key: {
            kty: "RSA",
            n: Buffer.from(challenge.modulus, "base64").toString("base64url"),
            e: "AQAB",
          },
          format: "jwk",
        }),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(JSON.stringify({ id: challenge.id, apiKey })),
    ).toString("base64"),
  };
}
async function fixture(offlineFixture = false) {
  const root = newSecureFixture();
  roots.push(root);
  const secure = join(root, "secure"),
    key = randomBytes(32);
  await preparePrivateDirectory(secure);
  const store = new SecureStorage(join(secure, secureDatabaseName), key);
  const now = new Date().toISOString(),
    sessionId = randomUUID();
  const events: ActivityEvent[] = ["First", "Second"].map((title) => ({
    id: randomUUID(),
    sessionId,
    type: "foreground",
    source: "windows",
    occurredAt: now,
    payload: {
      application: "SyntheticAssistant.exe",
      windowTitle: `${title} synthetic title 684901`,
    },
  }));
  try {
    expect((await store.open()).ok).toBe(true);
    expect(
      (
        await store.saveSettings({
          ...createDefaultSettings(),
          cloudAiEnabled: true,
        })
      ).ok,
    ).toBe(true);
    expect((await store.assistantCredential.write(0, privateKey, now)).ok).toBe(
      true,
    );
    const session = {
      id: sessionId,
      status: "active" as const,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
    };
    expect((await store.repositories.sessions.save(session)).ok).toBe(true);
    expect((await store.repositories.activities.append(events)).ok).toBe(true);
    expect(
      (
        await store.repositories.sessions.save({
          ...session,
          status: "ended",
          endedAt: now,
        })
      ).ok,
    ).toBe(true);
  } finally {
    expect((await store.close()).ok).toBe(true);
  }
  const responses = [planning(), answer()];
  const transport = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("UNEXPECTED_SYNTHETIC_HTTP");
    return next;
  });
  const start = async () => {
    const runtime = new WorkerRuntime({
      root: secure,
      key: Buffer.from(key),
      synthetic: true,
      ...(offlineFixture
        ? { assistantFixture: true as const }
        : { assistantTransport: transport }),
      onSnapshot: vi.fn(),
      onActivity: vi.fn(),
    });
    runtimes.push(runtime);
    expect((await runtime.initialize()).ok).toBe(true);
    return runtime;
  };
  const runtime = await start();
  const state = async (target = runtime) =>
    assistantControlResponseSchema.parse(
      await target.execute({ kind: "assistant.state" }),
    );
  const grant = async () => {
    expect(
      await runtime.execute({ kind: "assistant.permission", enabled: true }),
    ).toMatchObject({ ok: true, value: { permission: true } });
  };
  const prepare = async () => {
    const result = assistantReviewResponseSchema.parse(
      await runtime.execute({
        kind: "assistant.prepare",
        value: {
          question: "Which title was recorded?",
          activityIds: events.map((e) => e.id),
        },
      }),
    );
    if (!result.ok) throw new Error("SYNTHETIC_REVIEW_FAILED");
    return result.value;
  };
  return {
    runtime,
    root,
    secure,
    key,
    events,
    responses,
    transport,
    start,
    state,
    grant,
    prepare,
  };
}
it("runs the fixed offline fixture through the actual SDK without invoking global network access", async () => {
  const f = await fixture(true);
  await f.grant();
  const receipt = await f.prepare();
  expect(
    await f.runtime.execute({
      kind: "assistant.ask",
      value: { id: receipt.review.id, keys: ["E1"], confirmed: true },
    }),
  ).toMatchObject({
    ok: true,
    value: { answer: { insufficientEvidence: false } },
  });
  expect(f.transport).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("uses actual encrypted history and SDK transport only after launch approval and explicit reviewed subset confirmation", async () => {
  const f = await fixture();
  expect(await f.state()).toMatchObject({
    ok: true,
    value: { configured: true, permission: false },
  });
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.prepare",
        value: { question: "Question", activityIds: [f.events[0]!.id] },
      })
    ).ok,
  ).toBe(false);
  expect(f.transport).not.toHaveBeenCalled();
  await f.grant();
  const receipt = await f.prepare();
  expect(receipt.review.evidence.map((e) => e.source)).toEqual(
    f.events.map((event) => ({ kind: "activity", activityId: event.id })),
  );
  expect(f.transport).not.toHaveBeenCalled();
  f.responses.splice(0, 2, planning(["E2"]), answer(["E2"]));
  const result = assistantAnswerResponseSchema.parse(
    await f.runtime.execute({
      kind: "assistant.ask",
      value: { id: receipt.review.id, keys: ["E2"], confirmed: true },
    }),
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      revision: receipt.revision,
      answer: {
        sources: [{ kind: "activity", activityId: f.events[1]!.id }],
        insufficientEvidence: false,
      },
    },
  });
  expect(f.transport).toHaveBeenCalledTimes(2);
  const sent = f.transport.mock.calls
    .map(([, init]) => String(init?.body))
    .join("\n");
  expect(sent).toContain("Second synthetic title");
  expect(sent).not.toContain("First synthetic title");
  for (const marker of [privateKey, ...f.events.map((event) => event.id)])
    expect(sent).not.toContain(marker);
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.ask",
        value: { id: receipt.review.id, keys: ["E2"], confirmed: true },
      })
    ).ok,
  ).toBe(false);
  expect(f.transport).toHaveBeenCalledTimes(2);
  expect((await f.runtime.shutdown()).ok).toBe(true);
  const restarted = await f.start();
  expect(await f.state(restarted)).toMatchObject({
    ok: true,
    value: { configured: true, permission: false },
  });
  for (const name of readdirSync(f.secure)) {
    const bytes = readFileSync(join(f.secure, name));
    for (const encoding of ["utf8", "utf16le"] as const)
      expect(bytes.includes(Buffer.from(privateKey, encoding))).toBe(false);
  }
  expect(JSON.stringify(await f.state())).not.toContain(privateKey);
});
it("revokes a pending model request before confirmed deletion and refuses to replace a still-running transport", async () => {
  const f = await fixture();
  await f.grant();
  const receipt = await f.prepare();
  let release: (response: Response) => void = () => {};
  f.transport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const asking = f.runtime.execute({
    kind: "assistant.ask",
    value: { id: receipt.review.id, keys: ["E1"], confirmed: true },
  });
  try {
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(1));
    expect(
      (
        await f.runtime.execute({
          kind: "storage.delete",
          value: { confirmed: true, includeKept: true },
        })
      ).ok,
    ).toBe(true);
    expect((await asking).ok).toBe(false);
    expect(await f.state()).toMatchObject({
      ok: true,
      value: { permission: false, busy: true },
    });
    expect(
      await f.runtime.execute({ kind: "assistant.permission", enabled: true }),
    ).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(f.transport).toHaveBeenCalledTimes(1);
  } finally {
    release(planning());
  }
  await vi.waitFor(async () => {
    expect(
      (await f.runtime.execute({ kind: "assistant.permission", enabled: true }))
        .ok,
    ).toBe(true);
  });
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.prepare",
        value: { question: "Question", activityIds: [f.events[0]!.id] },
      })
    ).ok,
  ).toBe(false);
  expect(f.transport).toHaveBeenCalledTimes(1);
}, 15000);
it("reports a real retained-source integrity failure as unavailable and revokes cloud authority before transmission", async () => {
  const f = await fixture();
  await f.grant();
  const receipt = await f.prepare();
  const tamper = new NativeDatabase(join(f.secure, secureDatabaseName));
  try {
    tamper.pragma("cipher=sqlcipher");
    tamper.pragma("legacy=4");
    tamper.key(f.key);
    tamper
      .prepare(
        "UPDATE activities SET payload=json_set(payload,'$.windowTitle',123) WHERE id=?",
      )
      .run(f.events[0]!.id);
  } finally {
    tamper.close();
  }
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.ask",
        value: { id: receipt.review.id, keys: ["E1"], confirmed: true },
      })
    ).ok,
  ).toBe(false);
  expect(f.runtime.snapshot()).toMatchObject({
    service: "unavailable",
    assistant: { permission: false },
  });
  expect(f.transport).not.toHaveBeenCalled();
});
it("invalidates old reviews before exclusion changes and applies current exclusions after fresh approval", async () => {
  const f = await fixture();
  await f.grant();
  const receipt = await f.prepare();
  expect(
    (
      await f.runtime.execute({
        kind: "preferences.update",
        value: {
          collectionConsent: false,
          excludedApplications: ["SyntheticAssistant.exe"],
        },
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.ask",
        value: { id: receipt.review.id, keys: ["E1"], confirmed: true },
      })
    ).ok,
  ).toBe(false);
  await f.grant();
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.prepare",
        value: { question: "Question", activityIds: [f.events[0]!.id] },
      })
    ).ok,
  ).toBe(false);
  expect(f.transport).not.toHaveBeenCalled();
});
it("routes only sealed native credentials into the utility, keeps configuration separate from approval and supports explicit forgetting", async () => {
  const f = await fixture();
  await f.grant();
  const receipt = await f.prepare();
  const prepared = assistantCredentialChallengeResponseSchema.parse(
    await f.runtime.execute({
      kind: "assistant.credential.prepare",
      confirmed: true,
    }),
  );
  if (!prepared.ok) throw new Error("SYNTHETIC_CREDENTIAL_REVIEW_FAILED");
  expect(await f.state()).toMatchObject({
    ok: true,
    value: { permission: false, credentialPending: true },
  });
  const replacement = "Synthetic_Replacement_Gemini_684901";
  const sealed = seal(prepared.value, replacement);
  expect(
    await f.runtime.execute({
      kind: "assistant.credential.accept",
      value: sealed,
      confirmed: true,
    }),
  ).toMatchObject({ ok: true, value: { configured: true, permission: false } });
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.ask",
        value: { id: receipt.review.id, keys: ["E1"], confirmed: true },
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.credential.accept",
        value: sealed,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  await f.grant();
  expect(
    await f.runtime.execute({ kind: "assistant.forget", confirmed: true }),
  ).toMatchObject({
    ok: true,
    value: { configured: false, permission: false },
  });
  expect(
    (await f.runtime.execute({ kind: "assistant.permission", enabled: true }))
      .ok,
  ).toBe(false);
  expect(f.transport).not.toHaveBeenCalled();
  expect((await f.runtime.shutdown()).ok).toBe(true);
  const store = new SecureStorage(join(f.secure, secureDatabaseName), f.key);
  try {
    expect((await store.open()).ok).toBe(true);
    expect(await store.assistantCredential.read()).toMatchObject({
      ok: true,
      value: { apiKey: null },
    });
    expect(await store.timeline({ limit: 10 })).toMatchObject({
      ok: true,
      value: expect.arrayContaining(f.events),
    });
  } finally {
    await store.close();
  }
  expect(
    recordingCommandSchema.safeParse({
      kind: "assistant.credential.prepare",
      confirmed: true,
    }).success,
  ).toBe(false);
  expect(
    recordingCommandSchema.safeParse({
      kind: "assistant.credential.accept",
      value: sealed,
      confirmed: true,
    }).success,
  ).toBe(false);
}, 15000);
it("gives denial priority over a concurrent grant and cancels unused reviews without making a request", async () => {
  const f = await fixture();
  const granting = f.runtime.execute({
    kind: "assistant.permission",
    enabled: true,
  });
  const denying = f.runtime.execute({
    kind: "assistant.permission",
    enabled: false,
  });
  expect((await granting).ok).toBe(false);
  expect((await denying).ok).toBe(true);
  expect(await f.state()).toMatchObject({
    ok: true,
    value: { permission: false },
  });
  await f.grant();
  const receipt = await f.prepare();
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.cancel",
        id: receipt.review.id,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await f.runtime.execute({
        kind: "assistant.ask",
        value: { id: receipt.review.id, keys: ["E1"], confirmed: true },
      })
    ).ok,
  ).toBe(false);
  expect(f.transport).not.toHaveBeenCalled();
});
