import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { WorkerRuntime } from "./worker-runtime";
import {
  versionListResponseSchema,
  recoveryCopyProposalResponseSchema,
  browserControlResponseSchema,
  recoveryOverwriteProposalResponseSchema,
  recoveryOverwriteResultResponseSchema,
  type RuntimeSnapshot,
} from "@rewind/contracts";
import type { WindowQueryStrategy } from "@rewind/collectors";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

const directories: string[] = [];
const runtimes: WorkerRuntime[] = [];
it("overwrites an isolated target only after retaining its current bytes and rejects stale/deleted source proposals", async () => {
  const f = fixture(),
    source = join(f.profile, "protected-overwrite"),
    target = join(f.profile, "overwrite.txt");
  mkdirSync(source);
  writeFileSync(join(source, "source.txt"), "Retained synthetic version");
  expect((await f.runtime.initialize()).ok).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "files.add", path: source })).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "files.permission", enabled: true })).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  let versionId = "";
  await vi.waitFor(
    async () => {
      const list = versionListResponseSchema.parse(
        await f.runtime.execute({
          kind: "versions.list",
          query: { limit: 10 },
        }),
      );
      expect(list.ok && list.value.length).toBe(1);
      if (list.ok) versionId = list.value[0]!.version.id;
    },
    { timeout: 10000 },
  );
  expect((await f.runtime.execute({ kind: "session", action: "end" })).ok).toBe(
    true,
  );
  writeFileSync(target, "Current synthetic target");
  const prepare = async () => {
    const result = recoveryOverwriteProposalResponseSchema.parse(
      await f.runtime.execute({
        kind: "recovery.prepare-overwrite",
        versionId,
        path: target,
      }),
    );
    if (!result.ok || !result.value)
      throw new Error("SYNTHETIC_OVERWRITE_REVIEW_FAILED");
    return result.value;
  };
  const proposal = await prepare();
  expect(existsSync(proposal.preservationLabel)).toBe(false);
  const result = recoveryOverwriteResultResponseSchema.parse(
    await f.runtime.execute({
      kind: "recovery.confirm-overwrite",
      proposalId: proposal.id,
      confirmed: true,
    }),
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      mode: "overwrite",
      fileVersionId: versionId,
      preservationLabel: proposal.preservationLabel,
    },
  });
  expect(readFileSync(target, "utf8")).toBe("Retained synthetic version");
  expect(readFileSync(proposal.preservationLabel, "utf8")).toBe(
    "Current synthetic target",
  );
  const stale = await prepare();
  writeFileSync(target, "Intervening synthetic save");
  expect(
    await f.runtime.execute({
      kind: "recovery.confirm-overwrite",
      proposalId: stale.id,
      confirmed: true,
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(readFileSync(target, "utf8")).toBe("Intervening synthetic save");
  expect(existsSync(stale.preservationLabel)).toBe(false);
  const pending = await prepare();
  expect(
    (
      await f.runtime.execute({
        kind: "storage.delete",
        value: { includeKept: false, confirmed: true },
      })
    ).ok,
  ).toBe(true);
  expect(
    await f.runtime.execute({
      kind: "recovery.confirm-overwrite",
      proposalId: pending.id,
      confirmed: true,
    }),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(existsSync(pending.preservationLabel)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("Intervening synthetic save");
  expect(readFileSync(proposal.preservationLabel, "utf8")).toBe(
    "Current synthetic target",
  );
}, 35000);
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const directory of directories.splice(0)) removeSecureFixture(directory);
});
function fixture(strategy?: WindowQueryStrategy) {
  const profile = newSecureFixture();
  directories.push(profile);
  const root = join(profile, "secure");
  const key = randomBytes(32);
  const retainedKey = Buffer.from(key);
  const snapshots: RuntimeSnapshot[] = [];
  const runtime = new WorkerRuntime({
    root,
    key,
    synthetic: true,
    ...(strategy ? { strategy } : {}),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onActivity: vi.fn(),
  });
  runtimes.push(runtime);
  return { runtime, root, profile, key: retainedKey, snapshots };
}
it("reports stopping collection while draining an approved active session, then closes with an ended session", async () => {
  const f = fixture();
  expect((await f.runtime.initialize()).ok).toBe(true);
  expect(
    (
      await f.runtime.execute({
        kind: "preferences.update",
        value: { collectionConsent: true, excludedApplications: [] },
      })
    ).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  expect(f.runtime.snapshot().collection).toBe("active");
  const closing = f.runtime.shutdown();
  expect(f.runtime.snapshot()).toMatchObject({
    service: "stopping",
    collection: "stopping",
    preferences: { collectionConsent: false },
  });
  expect((await closing).ok).toBe(true);
  expect(f.runtime.snapshot()).toMatchObject({
    service: "stopping",
    collection: "off",
    secureStorage: false,
    session: { status: "ended" },
  });
  expect(f.snapshots.some((snapshot) => snapshot.service === "stopping")).toBe(
    true,
  );
  expect(
    f.snapshots.some(
      (snapshot) =>
        snapshot.service !== "ready" && snapshot.collection === "active",
    ),
  ).toBe(false);
});
it("keeps standard synthetic browser setup unavailable, saves real site policy and never grants browser collection", async () => {
  const f = fixture();
  expect((await f.runtime.initialize()).ok).toBe(true);
  const initial = browserControlResponseSchema.parse(
    await f.runtime.execute({ kind: "browser.state" }),
  );
  expect(initial).toMatchObject({
    ok: true,
    value: {
      permission: false,
      policyValid: true,
      setup: { state: "unavailable" },
      bridge: { state: "off", connected: 0 },
      capture: { state: "off", captured: 0 },
    },
  });
  expect(
    (await f.runtime.execute({ kind: "browser.permission", enabled: true })).ok,
  ).toBe(false);
  expect(
    (
      await f.runtime.execute({
        kind: "browser.install",
        browsers: ["chrome"],
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  expect((await f.runtime.execute({ kind: "browser.verify-assets" })).ok).toBe(
    false,
  );
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  const invalid = await f.runtime.execute({
    kind: "browser.exclusions",
    hosts: ["private.example/path"],
  });
  expect(invalid).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
  expect(f.runtime.snapshot().session?.status).toBe("active");
  const saved = browserControlResponseSchema.parse(
    await f.runtime.execute({
      kind: "browser.exclusions",
      hosts: ["Example.COM.", "example.com"],
    }),
  );
  expect(saved).toMatchObject({
    ok: true,
    value: {
      permission: false,
      excludedSiteHosts: ["example.com"],
      policyValid: true,
    },
  });
  expect(f.runtime.snapshot().session?.status).toBe("paused");
  expect((await f.runtime.shutdown()).ok).toBe(true);
  const restarted = new WorkerRuntime({
    root: f.root,
    key: f.key,
    synthetic: true,
    onSnapshot: vi.fn(),
    onActivity: vi.fn(),
  });
  runtimes.push(restarted);
  expect((await restarted.initialize()).ok).toBe(true);
  expect(await restarted.execute({ kind: "browser.state" })).toMatchObject({
    ok: true,
    value: { permission: false, excludedSiteHosts: ["example.com"] },
  });
  expect(restarted.snapshot().preferences.collectionConsent).toBe(false);
});
it("confirms native recovery copies from retained encrypted bytes and rejects deletion between review and confirmation", async () => {
  const f = fixture(),
    source = join(f.profile, "protected"),
    destination = join(f.profile, "recovered.txt");
  mkdirSync(source);
  writeFileSync(
    join(source, "source.txt"),
    "Synthetic recovery original bytes",
  );
  expect((await f.runtime.initialize()).ok).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "files.add", path: source })).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "files.permission", enabled: true })).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  const list = async () =>
    versionListResponseSchema.parse(
      await f.runtime.execute({ kind: "versions.list", query: { limit: 10 } }),
    );
  await vi.waitFor(
    async () => {
      const result = await list();
      expect(result.ok && result.value.length).toBe(1);
    },
    { timeout: 10000 },
  );
  expect(
    (await f.runtime.execute({ kind: "session", action: "pause" })).ok,
  ).toBe(true);
  const versions = await list();
  if (!versions.ok) throw new Error("Synthetic version unavailable");
  const versionId = versions.value[0]!.version.id;
  const prepare = async (target: string) => {
    const proposal = recoveryCopyProposalResponseSchema.parse(
      await f.runtime.execute({
        kind: "recovery.prepare-copy",
        versionId,
        path: target,
      }),
    );
    if (!proposal.ok || !proposal.value)
      throw new Error("Synthetic recovery proposal unavailable");
    return proposal.value;
  };
  const proposal = await prepare(destination);
  expect(existsSync(destination)).toBe(false);
  expect(
    await f.runtime.execute({
      kind: "recovery.confirm-copy",
      proposalId: proposal.id,
      confirmed: true,
    }),
  ).toMatchObject({
    ok: true,
    value: { fileVersionId: versionId, mode: "save-copy" },
  });
  expect(readFileSync(destination, "utf8")).toBe(
    "Synthetic recovery original bytes",
  );
  expect(
    (
      await f.runtime.execute({
        kind: "recovery.confirm-copy",
        proposalId: proposal.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.runtime.execute({
        kind: "recovery.prepare-copy",
        versionId,
        path: join(f.root, "forbidden.txt"),
      })
    ).ok,
  ).toBe(false);
  const deletedTarget = join(f.profile, "must-not-be-created.txt"),
    pending = await prepare(deletedTarget);
  expect(
    (
      await f.runtime.execute({
        kind: "storage.delete",
        value: { includeKept: false, confirmed: true },
      })
    ).ok,
  ).toBe(true);
  expect(
    await f.runtime.execute({
      kind: "recovery.confirm-copy",
      proposalId: pending.id,
      confirmed: true,
    }),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(existsSync(deletedTarget)).toBe(false);
  expect(readFileSync(destination, "utf8")).toBe(
    "Synthetic recovery original bytes",
  );
}, 25000);
it("captures real synthetic folder saves with file-only approval, drains pause/revoke and reopens encrypted versions", async () => {
  const query = vi.fn(async () => ({
    application: "Synthetic.exe",
    windowTitle: "Must not be sampled",
  }));
  const f = fixture({ getActiveWindow: query });
  const source = join(f.profile, "protected");
  mkdirSync(source);
  const target = join(source, "synthetic.txt");
  writeFileSync(target, "SyntheticAlphaBytes9482");
  expect((await f.runtime.initialize()).ok).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "files.add", path: f.profile })).ok,
  ).toBe(false);
  expect(
    (await f.runtime.execute({ kind: "files.add", path: source })).ok,
  ).toBe(true);
  expect(f.runtime.snapshot().filePermission).toBe(false);
  expect(
    (await f.runtime.execute({ kind: "files.permission", enabled: true })).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  const list = async () => {
    const result = await f.runtime.execute({
      kind: "versions.list",
      query: { limit: 100 },
    });
    if (!result.ok || !Array.isArray(result.value))
      throw new Error("Synthetic captures unavailable");
    return result.value as {
      version: { id: string; fileId: string };
      displayName: string;
    }[];
  };
  await vi.waitFor(async () => expect(await list()).toHaveLength(1), {
    timeout: 8000,
  });
  const first = (await list())[0]!;
  expect(
    await f.runtime.execute({ kind: "versions.preview", id: first.version.id }),
  ).toMatchObject({ ok: true, value: { text: "SyntheticAlphaBytes9482" } });
  expect(query).not.toHaveBeenCalled();
  expect(
    await f.runtime.execute({
      kind: "timeline",
      query: { limit: 10, text: "synthetic", types: ["file-change"] },
    }),
  ).toMatchObject({
    ok: true,
    value: [
      expect.objectContaining({
        type: "file-change",
        payload: expect.objectContaining({ displayName: "synthetic.txt" }),
      }),
    ],
  });
  expect(
    await f.runtime.execute({
      kind: "timeline",
      query: {
        limit: 10,
        text: Array.from({ length: 31 }, () => "term").join(" "),
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  writeFileSync(target, "SyntheticBetaBytes9482");
  await vi.waitFor(async () => expect(await list()).toHaveLength(2), {
    timeout: 8000,
  });
  expect(
    (await f.runtime.execute({ kind: "session", action: "pause" })).ok,
  ).toBe(true);
  writeFileSync(target, "SyntheticGammaBytes9482");
  await new Promise((resolve) => setTimeout(resolve, 2200));
  expect(await list()).toHaveLength(2);
  await f.runtime.execute({ kind: "session", action: "resume" });
  await vi.waitFor(async () => expect(await list()).toHaveLength(3), {
    timeout: 8000,
  });
  expect(
    (await f.runtime.execute({ kind: "files.permission", enabled: false })).ok,
  ).toBe(true);
  writeFileSync(target, "SyntheticDeltaBytes9482");
  await new Promise((resolve) => setTimeout(resolve, 2200));
  expect(await list()).toHaveLength(3);
  expect(f.runtime.snapshot().collection).toBe("off");
  await f.runtime.shutdown();
  expect(
    readFileSync(join(f.root, "history.sqlite")).includes(
      Buffer.from("SyntheticAlphaBytes9482"),
    ),
  ).toBe(false);
  const restarted = new WorkerRuntime({
    root: f.root,
    key: new Uint8Array(f.key),
    synthetic: true,
    onSnapshot: vi.fn(),
    onActivity: vi.fn(),
  });
  runtimes.push(restarted);
  expect((await restarted.initialize()).ok).toBe(true);
  expect(restarted.snapshot().filePermission).toBe(false);
  expect(await restarted.execute({ kind: "files.state" })).toMatchObject({
    ok: true,
    value: {
      permission: false,
      folders: [expect.objectContaining({ absolutePath: source })],
    },
  });
  expect(
    await restarted.execute({ kind: "versions.preview", id: first.version.id }),
  ).toMatchObject({ ok: true, value: { text: "SyntheticAlphaBytes9482" } });
  await restarted.execute({ kind: "files.permission", enabled: true });
  await restarted.execute({ kind: "session", action: "start" });
  await vi.waitFor(
    async () => {
      const history = await restarted.execute({
        kind: "versions.list",
        query: { limit: 100 },
      });
      const parsed = versionListResponseSchema.parse(history);
      if (!parsed.ok)
        throw new Error("Synthetic restarted captures unavailable");
      expect(parsed.value).toHaveLength(4);
      expect(parsed.value[0]!.version.fileId).toBe(first.version.fileId);
    },
    { timeout: 8000 },
  );
  expect(query).not.toHaveBeenCalled();
}, 30000);
it("a later revoke supersedes a grant still checking storage", async () => {
  const f = fixture();
  await f.runtime.initialize();
  const grant = f.runtime.execute({
    kind: "preferences.update",
    value: { collectionConsent: true, excludedApplications: [] },
  });
  const revoke = f.runtime.execute({
    kind: "preferences.update",
    value: { collectionConsent: false, excludedApplications: [] },
  });
  const results = await Promise.all([grant, revoke]);
  expect(results[0]).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(results[1].ok).toBe(true);
  expect(f.runtime.snapshot().preferences.collectionConsent).toBe(false);
});
it("automatically expires encrypted history while open without a timeline query", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    const f = fixture();
    await f.runtime.initialize();
    await f.runtime.execute({ kind: "session", action: "start" });
    const id = f.runtime.snapshot().session!.id;
    const db = new NativeDatabase(join(f.root, "history.sqlite"));
    try {
      db.pragma("cipher=sqlcipher");
      db.pragma("legacy=4");
      db.key(f.key);
      db.prepare("INSERT INTO activities VALUES (?,?,?,?,?,?)").run(
        "10000000-0000-4000-8000-000000000099",
        id,
        "foreground",
        "windows",
        "2026-11-10T10:00:00.000Z",
        JSON.stringify({
          application: "Synthetic.exe",
          windowTitle: "Timer expiry fixture",
        }),
      );
    } finally {
      db.close();
    }
    expect(await f.runtime.execute({ kind: "storage.usage" })).toMatchObject({
      ok: true,
      value: { activityCount: 1 },
    });
    vi.setSystemTime(new Date("2026-11-17T10:00:00.000Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await f.runtime.execute({ kind: "storage.usage" })).toMatchObject({
      ok: true,
      value: { activityCount: 0 },
    });
    expect(f.runtime.snapshot().preferences.collectionConsent).toBe(false);
    await f.runtime.shutdown();
  } finally {
    vi.useRealTimers();
  }
});
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
    browserPermission: false,
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
  expect(f.runtime.snapshot()).toMatchObject({
    preferences: { collectionConsent: false },
    filePermission: false,
    browserPermission: false,
  });
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
