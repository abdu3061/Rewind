import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createDefaultSettings,
  createBrowserSetupJournal,
} from "@rewind/contracts";
import { SecureStorage } from "./secure-storage";
import { AssistantCredentialRepository } from "./assistant-credential-repository";
import { applySecureMigrations, secureMigrations } from "./migrations";
import type { DatabaseConnection, SqlValue } from "./database";
import {
  newSecureFixture,
  removeSecureFixture,
} from "./secure-fixtures.test-support";

let root: string, file: string, key: Buffer;
const opened: SecureStorage[] = [];
const marker = "Synthetic_Encrypted_Gemini_Credential_9701",
  at = "2026-11-18T10:00:00.000Z";
beforeEach(() => {
  root = newSecureFixture();
  file = path.join(root, "history.sqlite");
  key = randomBytes(32);
});
afterEach(async () => {
  for (const storage of opened.splice(0))
    expect((await storage.close()).ok).toBe(true);
  key.fill(0);
  removeSecureFixture(root);
});
function storage(secret: Uint8Array = key) {
  const value = new SecureStorage(file, secret);
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
it("keeps the private credential encrypted in live DB/journals and across reopen without indexing or granting cloud consent", async () => {
  const first = storage();
  expect((await first.open()).ok).toBe(true);
  expect(await first.assistantCredential.read()).toEqual({
    ok: true,
    value: { revision: 0, apiKey: null, updatedAt: null },
  });
  expect((await first.assistantCredential.write(0, marker, at)).ok).toBe(true);
  expect(await first.assistantCredential.read()).toEqual({
    ok: true,
    value: { revision: 1, apiKey: marker, updatedAt: at },
  });
  expect(readdirSync(root)).toContain("history.sqlite-wal");
  for (const name of readdirSync(root)) {
    const bytes = readFileSync(path.join(root, name));
    for (const encoding of ["utf8", "utf16le"] as const)
      expect(bytes.includes(Buffer.from(marker, encoding))).toBe(false);
  }
  expect(await first.timeline({ text: marker, limit: 10 })).toEqual({
    ok: true,
    value: [],
  });
  expect(await first.getSettings()).toMatchObject({
    ok: true,
    value: {
      cloudAiEnabled: false,
      collectionConsent: false,
      folderCollectionConsent: false,
      browserCollectionConsent: false,
    },
  });
  expect((await first.close()).ok).toBe(true);
  const reopened = storage();
  expect((await reopened.open()).ok).toBe(true);
  expect(await reopened.assistantCredential.read()).toMatchObject({
    ok: true,
    value: { revision: 1, apiKey: marker },
  });
});
it("preserves operational credentials through history expiration/deletion and confirms explicit credential removal separately", async () => {
  const first = storage();
  expect((await first.open()).ok).toBe(true);
  expect((await first.assistantCredential.write(0, marker, at)).ok).toBe(true);
  expect((await first.cleanup(new Date("2030-01-01T00:00:00.000Z"))).ok).toBe(
    true,
  );
  expect(
    (await first.deleteHistory({ confirmed: true, includeKept: true })).ok,
  ).toBe(true);
  expect(await first.assistantCredential.read()).toMatchObject({
    ok: true,
    value: { apiKey: marker, revision: 1 },
  });
  expect((await first.assistantCredential.write(1, null, at)).ok).toBe(true);
  expect((await first.close()).ok).toBe(true);
  const reopened = storage();
  expect((await reopened.open()).ok).toBe(true);
  expect(await reopened.assistantCredential.read()).toEqual({
    ok: true,
    value: { revision: 2, apiKey: null, updatedAt: at },
  });
});
it("rejects stale or invalid secret updates and keeps competing writes revision checked", async () => {
  const db = storage();
  await db.open();
  for (const value of [
    "short",
    "x".repeat(513),
    "Synthetic secret with spaces",
    marker + "\n",
    "Synthetic_秘密_Credential",
  ])
    expect((await db.assistantCredential.write(0, value, at)).ok).toBe(false);
  expect(
    (await db.assistantCredential.write(0, marker, "invalid time")).ok,
  ).toBe(false);
  expect((await db.assistantCredential.write(-1, marker, at)).ok).toBe(false);
  const results = await Promise.all([
    db.assistantCredential.write(0, marker, at),
    db.assistantCredential.write(0, "Different_Synthetic_Credential_9701", at),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({
    error: { code: "CONFLICT" },
  });
  expect(await db.assistantCredential.read()).toMatchObject({
    ok: true,
    value: { revision: 1, apiKey: marker },
  });
});
it("rolls back failed credential persistence without revealing secret diagnostics or taking a caller transaction", async () => {
  const db = storage();
  await db.open();
  const writer = raw();
  try {
    writer.exec(
      "CREATE TRIGGER synthetic_credential_failure BEFORE UPDATE ON assistant_credential BEGIN SELECT RAISE(ABORT,'Synthetic_Encrypted_Gemini_Credential_9701'); END;",
    );
    const failed = await db.assistantCredential.write(0, marker, at);
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(marker);
    expect(await db.assistantCredential.read()).toMatchObject({
      ok: true,
      value: { revision: 0, apiKey: null },
    });
    writer.exec("DROP TRIGGER synthetic_credential_failure; BEGIN IMMEDIATE");
    const repository = new AssistantCredentialRepository(connection(writer));
    expect(await repository.write(0, marker, at)).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(writer.inTransaction).toBe(true);
    writer.exec("ROLLBACK");
    expect((await db.assistantCredential.write(0, marker, at)).ok).toBe(true);
  } finally {
    writer.close();
  }
});
it.each(["missing", "invalid-key", "oversized-key"] as const)(
  "refuses %s credential state on startup without recreating or replacing it",
  async (kind) => {
    const first = storage();
    await first.open();
    await first.close();
    const writer = raw();
    if (kind === "missing") writer.exec("DELETE FROM assistant_credential");
    else {
      writer.pragma("ignore_check_constraints=ON");
      writer
        .prepare(
          "UPDATE assistant_credential SET revision=1,api_key=?,updated_at=? WHERE id=1",
        )
        .run(
          kind === "invalid-key"
            ? "Invalid secret with spaces"
            : "x".repeat(513),
          at,
        );
    }
    const original = writer.prepare("SELECT * FROM assistant_credential").all();
    writer.close();
    const failed = storage();
    expect((await failed.open()).ok).toBe(false);
    expect(() => failed.assistantCredential).toThrow();
    const verify = raw();
    try {
      expect(
        verify.prepare("SELECT * FROM assistant_credential").all(),
      ).toEqual(original);
    } finally {
      verify.close();
    }
  },
);
it("upgrades encrypted schema eight without replacing existing settings, browser ownership or session evidence", async () => {
  const writer = raw();
  applySecureMigrations(connection(writer), secureMigrations.slice(0, 8));
  const settings = {
      ...createDefaultSettings(),
      excludedApplications: ["SyntheticPriorCredentialSchema.exe"],
    },
    session = randomUUID();
  writer
    .prepare("INSERT INTO runtime_settings VALUES(1,?)")
    .run(JSON.stringify(settings));
  writer
    .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
    .run(session, "ended", at, at, at);
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
  expect(await updated.assistantCredential.read()).toEqual({
    ok: true,
    value: { revision: 0, apiKey: null, updatedAt: null },
  });
});
it("does not disclose or replace credentials when a wrong storage key is supplied", async () => {
  const first = storage();
  await first.open();
  await first.assistantCredential.write(0, marker, at);
  await first.close();
  const wrong = storage(randomBytes(32));
  expect((await wrong.open()).ok).toBe(false);
  const reopened = storage();
  expect((await reopened.open()).ok).toBe(true);
  expect(await reopened.assistantCredential.read()).toMatchObject({
    ok: true,
    value: { apiKey: marker, revision: 1 },
  });
});
