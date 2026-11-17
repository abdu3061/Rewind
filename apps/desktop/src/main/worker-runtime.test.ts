import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { join } from "node:path";
import { WorkerRuntime } from "./worker-runtime";
import type { WindowQueryStrategy } from "@rewind/collectors";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

const directories: string[] = [];
const runtimes: WorkerRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const directory of directories.splice(0)) removeSecureFixture(directory);
});
function fixture(strategy?: WindowQueryStrategy) {
  const root = newSecureFixture();
  directories.push(root);
  const key = randomBytes(32);
  const retainedKey = Buffer.from(key);
  const runtime = new WorkerRuntime({
    root,
    key,
    synthetic: true,
    ...(strategy ? { strategy } : {}),
    onSnapshot: vi.fn(),
    onActivity: vi.fn(),
  });
  runtimes.push(runtime);
  return { runtime, root, key: retainedKey };
}
it("persists synthetic observations only after explicit grant and drains pause/end/revocation", async () => {
  const f = fixture();
  expect((await f.runtime.initialize()).ok).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  expect(
    await f.runtime.execute({ kind: "timeline", query: { limit: 10 } }),
  ).toEqual({ ok: true, value: [] });
  expect(f.runtime.snapshot().collection).toBe("off");
  expect(
    (
      await f.runtime.execute({
        kind: "preferences.update",
        value: { collectionConsent: true, excludedApplications: [] },
      })
    ).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "session", action: "resume" })).ok,
  ).toBe(true);
  await vi.waitFor(async () => {
    const result = await f.runtime.execute({
      kind: "timeline",
      query: { limit: 10 },
    });
    expect(
      result.ok && Array.isArray(result.value) && result.value.length,
    ).toBe(1);
  });
  expect(
    (await f.runtime.execute({ kind: "session", action: "pause" })).ok,
  ).toBe(true);
  const paused = await f.runtime.execute({
    kind: "timeline",
    query: { limit: 10 },
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(
    await f.runtime.execute({ kind: "timeline", query: { limit: 10 } }),
  ).toEqual(paused);
  await f.runtime.execute({ kind: "session", action: "resume" });
  expect(
    (
      await f.runtime.execute({
        kind: "preferences.update",
        value: { collectionConsent: false, excludedApplications: [] },
      })
    ).ok,
  ).toBe(true);
  expect(f.runtime.snapshot().preferences.collectionConsent).toBe(false);
  expect(f.runtime.snapshot().collection).toBe("off");
  expect((await f.runtime.execute({ kind: "session", action: "end" })).ok).toBe(
    true,
  );
});
it("retains history and exclusions across worker restart but expires approval", async () => {
  const f = fixture();
  await f.runtime.initialize();
  await f.runtime.execute({
    kind: "preferences.update",
    value: { collectionConsent: true, excludedApplications: ["private.exe"] },
  });
  await f.runtime.execute({ kind: "session", action: "start" });
  await f.runtime.shutdown();
  const restarted = new WorkerRuntime({
    root: f.root,
    key: Buffer.from(f.key),
    synthetic: true,
    onSnapshot: vi.fn(),
    onActivity: vi.fn(),
  });
  runtimes.push(restarted);
  expect((await restarted.initialize()).ok).toBe(true);
  expect(restarted.snapshot()).toMatchObject({
    session: { status: "ended" },
    preferences: {
      collectionConsent: false,
      excludedApplications: ["private.exe"],
    },
    collection: "off",
  });
  const history = await restarted.execute({
    kind: "history",
    query: { limit: 10 },
  });
  expect(history.ok && history.value).toHaveLength(1);
});
it("does not enable collection when persisting approval fails", async () => {
  const f = fixture();
  await f.runtime.initialize();
  const db = new NativeDatabase(join(f.root, "history.sqlite"));
  db.pragma("cipher=sqlcipher");
  db.pragma("legacy=4");
  db.key(f.key);
  try {
    db.exec(
      "CREATE TRIGGER fail_settings BEFORE UPDATE ON runtime_settings BEGIN SELECT RAISE(FAIL,'synthetic'); END;",
    );
    expect(
      (
        await f.runtime.execute({
          kind: "preferences.update",
          value: { collectionConsent: true, excludedApplications: [] },
        })
      ).ok,
    ).toBe(false);
    expect(f.runtime.snapshot().preferences.collectionConsent).toBe(false);
    expect(
      (await f.runtime.execute({ kind: "session", action: "start" })).ok,
    ).toBe(false);
  } finally {
    db.close();
  }
});
it("enforces application exclusions on the actual recording pipeline", async () => {
  const f = fixture();
  await f.runtime.initialize();
  await f.runtime.execute({
    kind: "preferences.update",
    value: {
      collectionConsent: true,
      excludedApplications: ["syntheticeditor"],
    },
  });
  await f.runtime.execute({ kind: "session", action: "start" });
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(
    await f.runtime.execute({ kind: "timeline", query: { limit: 10 } }),
  ).toEqual({ ok: true, value: [] });
});
it("retains a capture gap and readable history when the active window source becomes unavailable", async () => {
  let queries = 0;
  const f = fixture({
    getActiveWindow: async () => {
      if (++queries > 1)
        throw new Error("Synthetic private upstream diagnostic");
      return {
        application: "SyntheticEditor.exe",
        windowTitle: "Synthetic readiness",
      };
    },
  });
  await f.runtime.initialize();
  await f.runtime.execute({
    kind: "preferences.update",
    value: { collectionConsent: true, excludedApplications: [] },
  });
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  await vi.waitFor(() =>
    expect(f.runtime.snapshot().service).toBe("unavailable"),
  );
  expect(f.runtime.snapshot().secureStorage).toBe(true);
  const result = await f.runtime.execute({
    kind: "timeline",
    query: { limit: 10 },
  });
  expect(result).toMatchObject({
    ok: true,
    value: [
      {
        type: "capture-gap",
        payload: { collectorId: "windows", reason: "unavailable" },
      },
    ],
  });
  const stoppedAt = queries;
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(queries).toBe(stoppedAt);
  expect(JSON.stringify(f.runtime.snapshot())).not.toContain(
    "Synthetic private upstream diagnostic",
  );
});
