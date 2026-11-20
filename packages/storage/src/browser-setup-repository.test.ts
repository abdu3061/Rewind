import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  browserSetupJournalSchema,
  createBrowserSetupJournal,
  createDefaultSettings,
  type BrowserSetupGeneration,
  type BrowserSetupJournal,
} from "@rewind/contracts";
import { SecureStorage } from "./secure-storage";
import { BrowserSetupRepository } from "./browser-setup-repository";
import { applySecureMigrations, secureMigrations } from "./migrations";
import type { DatabaseConnection, SqlValue } from "./database";
import {
  newSecureFixture,
  removeSecureFixture,
} from "./secure-fixtures.test-support";

let root: string, file: string, key: Buffer;
const opened: SecureStorage[] = [];
beforeEach(() => {
  root = newSecureFixture();
  file = path.join(root, "history.sqlite");
  key = randomBytes(32);
});
afterEach(async () => {
  for (const item of opened.splice(0))
    expect((await item.close()).ok).toBe(true);
  key.fill(0);
  removeSecureFixture(root);
});
function storage() {
  const value = new SecureStorage(file, key);
  opened.push(value);
  return value;
}
function raw() {
  const db = new NativeDatabase(file);
  db.pragma("cipher=sqlcipher");
  db.pragma("legacy=4");
  db.key(key);
  return db;
}
function connection(
  db: InstanceType<typeof NativeDatabase>,
): DatabaseConnection {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare<SqlValue[], Record<string, unknown>>(sql),
    get isTransaction() {
      return db.inTransaction;
    },
  };
}
const marker = "SyntheticOwnedBrowserSetupReceipt";
function generation(): BrowserSetupGeneration {
  return {
    hostName: "com.rewind.bridge",
    id: randomUUID(),
    createdAt: "2026-11-17T12:00:00.000Z",
    directoryIdentity: `${marker}-directory`,
    native: {
      osIdentity: `${marker}-native`,
      contentHash: "a".repeat(64),
      byteLength: 23552,
    },
    configuration: {
      osIdentity: `${marker}-config`,
      contentHash: "b".repeat(64),
      byteLength: 1024,
    },
    manifest: {
      osIdentity: `${marker}-manifest`,
      contentHash: "c".repeat(64),
      byteLength: 256,
    },
    desktopHash: "d".repeat(64),
    nativeSourceHash: "e".repeat(64),
    extensionId: "a".repeat(32),
    browsers: ["chrome", "edge"],
  };
}
function prepared(): BrowserSetupJournal {
  const item = generation();
  return {
    ...createBrowserSetupJournal(),
    revision: 1,
    generations: [item],
    pending: {
      operation: "install",
      generationId: item.id,
      browsers: ["chrome", "edge"],
      previous: { chrome: null, edge: null },
    },
  };
}
it("persists pending ownership encrypted across restart and history deletion without granting collection", async () => {
  const first = storage();
  expect((await first.open()).ok).toBe(true);
  expect(await first.browserSetup.read()).toEqual({
    ok: true,
    value: createBrowserSetupJournal(),
  });
  const pending = prepared();
  expect((await first.browserSetup.write(0, pending)).ok).toBe(true);
  expect(await first.browserSetup.read()).toEqual({ ok: true, value: pending });
  expect(readdirSync(root)).toContain("history.sqlite-wal");
  for (const name of readdirSync(root)) {
    const bytes = readFileSync(path.join(root, name));
    for (const value of [marker, pending.generations[0]!.id])
      for (const encoding of ["utf8", "utf16le"] as const)
        expect(bytes.includes(Buffer.from(value, encoding))).toBe(false);
  }
  expect((await first.close()).ok).toBe(true);
  const second = storage();
  expect((await second.open()).ok).toBe(true);
  expect(await second.browserSetup.read()).toEqual({
    ok: true,
    value: pending,
  });
  expect((await second.cleanup(new Date("2030-01-01T00:00:00.000Z"))).ok).toBe(
    true,
  );
  expect(
    (await second.deleteHistory({ confirmed: true, includeKept: true })).ok,
  ).toBe(true);
  expect(await second.browserSetup.read()).toEqual({
    ok: true,
    value: pending,
  });
  expect(await second.getSettings()).toMatchObject({
    ok: true,
    value: {
      collectionConsent: false,
      folderCollectionConsent: false,
      browserCollectionConsent: false,
      cloudAiEnabled: false,
      articleExtractionEnabled: false,
    },
  });
  const complete: BrowserSetupJournal = {
    ...pending,
    revision: 2,
    registrations: {
      chrome: pending.generations[0]!.id,
      edge: pending.generations[0]!.id,
    },
    pending: null,
  };
  expect((await second.browserSetup.write(1, complete)).ok).toBe(true);
  expect((await second.close()).ok).toBe(true);
  const third = storage();
  expect((await third.open()).ok).toBe(true);
  expect(await third.browserSetup.read()).toEqual({
    ok: true,
    value: complete,
  });
});

it("rejects stale updates, receipt replacement/removal, dangling references and persisted approvals without changing ownership", async () => {
  const db = storage();
  expect((await db.open()).ok).toBe(true);
  const pending = prepared();
  expect((await db.browserSetup.write(0, pending)).ok).toBe(true);
  expect(await db.browserSetup.write(0, pending)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  const invalid: unknown[] = [
    { ...pending, revision: 2, generations: [] },
    {
      ...pending,
      revision: 2,
      generations: [
        { ...pending.generations[0]!, desktopHash: "e".repeat(64) },
      ],
    },
    {
      ...pending,
      revision: 2,
      registrations: { chrome: randomUUID(), edge: null },
    },
    {
      ...pending,
      revision: 2,
      generations: [pending.generations[0], pending.generations[0]],
    },
    { ...pending, revision: 2, permission: true },
    {
      ...pending,
      revision: 2,
      pending: { ...pending.pending!, permission: true },
    },
  ];
  for (const candidate of invalid)
    expect(
      (await db.browserSetup.write(1, candidate as BrowserSetupJournal)).ok,
    ).toBe(false);
  expect(await db.browserSetup.read()).toEqual({ ok: true, value: pending });
  const competing = await Promise.all([
    db.browserSetup.write(1, { ...pending, revision: 2, pending: null }),
    db.browserSetup.write(1, {
      ...pending,
      revision: 2,
      registrations: { chrome: pending.generations[0]!.id, edge: null },
    }),
  ]);
  expect(competing.filter((result) => result.ok)).toHaveLength(1);
  expect(competing.find((result) => !result.ok)).toMatchObject({
    error: { code: "CONFLICT" },
  });
});

it("rolls back failed writes and does not take over a caller transaction", async () => {
  const db = storage();
  expect((await db.open()).ok).toBe(true);
  const writer = raw();
  try {
    writer.exec(
      "CREATE TRIGGER synthetic_setup_failure BEFORE UPDATE ON browser_setup_journal BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    expect((await db.browserSetup.write(0, prepared())).ok).toBe(false);
    expect(await db.browserSetup.read()).toEqual({
      ok: true,
      value: createBrowserSetupJournal(),
    });
    writer.exec("DROP TRIGGER synthetic_setup_failure; BEGIN IMMEDIATE");
    const repository = new BrowserSetupRepository(connection(writer));
    expect(await repository.write(0, prepared())).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(writer.inTransaction).toBe(true);
    writer.exec("ROLLBACK");
    expect((await db.browserSetup.write(0, prepared())).ok).toBe(true);
  } finally {
    writer.close();
  }
});

it.each(["missing", "malformed", "extra-permission"] as const)(
  "fails startup on %s ownership without recreating or erasing the stored journal",
  async (kind) => {
    const first = storage();
    expect((await first.open()).ok).toBe(true);
    expect((await first.close()).ok).toBe(true);
    const writer = raw();
    if (kind === "missing") writer.exec("DELETE FROM browser_setup_journal");
    else
      writer
        .prepare("UPDATE browser_setup_journal SET payload=? WHERE id=1")
        .run(
          JSON.stringify({
            ...createBrowserSetupJournal(),
            ...(kind === "malformed"
              ? { registrations: { chrome: randomUUID(), edge: null } }
              : { permission: true }),
          }),
        );
    const stored = writer
      .prepare("SELECT payload FROM browser_setup_journal")
      .all();
    writer.close();
    const failed = storage();
    expect((await failed.open()).ok).toBe(false);
    expect(() => failed.browserSetup).toThrow();
    const verify = raw();
    try {
      expect(
        verify.prepare("SELECT payload FROM browser_setup_journal").all(),
      ).toEqual(stored);
    } finally {
      verify.close();
    }
  },
);

it("upgrades the previous encrypted schema without replacing existing settings or evidence", async () => {
  const writer = raw();
  applySecureMigrations(connection(writer), secureMigrations.slice(0, 7));
  const settings = {
    ...createDefaultSettings(),
    excludedApplications: ["SyntheticPriorSchema.exe"],
  };
  writer
    .prepare("INSERT INTO runtime_settings VALUES(1,?)")
    .run(JSON.stringify(settings));
  const session = randomUUID();
  writer
    .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
    .run(
      session,
      "ended",
      "2026-11-17T10:00:00.000Z",
      "2026-11-17T11:00:00.000Z",
      "2026-11-17T11:00:00.000Z",
    );
  writer.close();
  const updated = storage();
  expect((await updated.open()).ok).toBe(true);
  expect(await updated.getSettings()).toEqual({ ok: true, value: settings });
  expect(await updated.browserSetup.read()).toEqual({
    ok: true,
    value: createBrowserSetupJournal(),
  });
  expect(await updated.repositories.sessions.get(session)).toMatchObject({
    ok: true,
    value: { id: session, status: "ended" },
  });
});

it("bounds receipts and denies foreign browser references", () => {
  const state = prepared();
  state.generations = Array.from({ length: 129 }, generation);
  expect(browserSetupJournalSchema.safeParse(state).success).toBe(false);
  const scoped = prepared();
  scoped.generations[0]!.browsers = ["chrome"];
  expect(browserSetupJournalSchema.safeParse(scoped).success).toBe(false);
  const shared = prepared(),
    second = generation();
  shared.generations.push(second);
  shared.registrations = { chrome: shared.generations[0]!.id, edge: second.id };
  expect(browserSetupJournalSchema.safeParse(shared).success).toBe(false);
});
