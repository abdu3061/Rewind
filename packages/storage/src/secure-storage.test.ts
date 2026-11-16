import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDefaultSettings, type Session } from "@rewind/contracts";
import { SecureStorage } from "./secure-storage";
import {
  newSecureFixture,
  removeSecureFixture,
} from "./secure-fixtures.test-support";

let directory: string;
let file: string;
let key: Buffer;
const adapters: SecureStorage[] = [];
const session: Session = {
  id: "00000000-0000-4000-8000-000000000001",
  status: "active",
  startedAt: "2026-11-17T10:00:00.000Z",
  updatedAt: "2026-11-17T10:00:00.000Z",
  endedAt: null,
};
const marker = "RewindSensitiveFixture0362";
beforeEach(() => {
  directory = newSecureFixture();
  file = join(directory, "history.sqlite");
  key = randomBytes(32);
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  key.fill(0);
  removeSecureFixture(directory);
});
function adapter(secret: Uint8Array = key): SecureStorage {
  const value = new SecureStorage(file, secret);
  adapters.push(value);
  return value;
}
async function populate(storage: SecureStorage): Promise<void> {
  expect((await storage.open()).ok).toBe(true);
  expect((await storage.repositories.sessions.save(session)).ok).toBe(true);
  expect(
    (
      await storage.repositories.activities.append([
        {
          id: "10000000-0000-4000-8000-000000000001",
          sessionId: session.id,
          occurredAt: session.startedAt,
          type: "foreground",
          source: "windows",
          payload: { application: "Synthetic.exe", windowTitle: marker },
        },
      ])
    ).ok,
  ).toBe(true);
}
function inspect() {
  const db = new NativeDatabase(file);
  db.pragma("cipher=sqlcipher");
  db.pragma("legacy=4");
  db.key(key);
  return db;
}

it("encrypts database/WAL/index contents and reopens actual persisted events and settings", async () => {
  const first = adapter();
  await populate(first);
  expect(
    (
      await first.saveSettings({
        ...createDefaultSettings(),
        excludedApplications: [marker],
      })
    ).ok,
  ).toBe(true);
  expect(await first.timeline({ text: marker, limit: 10 })).toMatchObject({
    ok: true,
    value: [expect.objectContaining({ type: "foreground" })],
  });
  const files = readdirSync(directory);
  expect(files).toContain("history.sqlite-wal");
  for (const name of files) {
    const bytes = readFileSync(join(directory, name));
    expect(bytes.includes(Buffer.from(marker))).toBe(false);
    expect(bytes.includes(Buffer.from(marker, "utf16le"))).toBe(false);
  }
  expect(readFileSync(file).subarray(0, 16).toString()).not.toBe(
    "SQLite format 3\0",
  );
  await first.close();
  const second = adapter();
  expect(await second.open()).toEqual({ ok: true, value: undefined });
  expect(await second.history({ limit: 10 })).toEqual({
    ok: true,
    value: [session],
  });
  expect(await second.getSettings()).toMatchObject({
    ok: true,
    value: { excludedApplications: [marker] },
  });
  expect((await second.timeline({ text: marker, limit: 10 })).ok).toBe(true);
});
it("rejects wrong/missing keys without exposing or replacing existing history", async () => {
  const first = adapter();
  await populate(first);
  await first.close();
  const original = readFileSync(file);
  const wrong = adapter(randomBytes(32));
  expect((await wrong.open()).ok).toBe(false);
  expect(() => wrong.repositories).toThrow();
  expect(readFileSync(file)).toEqual(original);
  expect((await adapter(new Uint8Array()).open()).ok).toBe(false);
  expect(await adapter().open()).toEqual({ ok: true, value: undefined });
});
it("detects ciphertext tampering and never reinitializes corrupted content", async () => {
  const first = adapter();
  await populate(first);
  await first.close();
  const corrupt = readFileSync(file);
  corrupt[100] = corrupt[100]! ^ 1;
  writeFileSync(file, corrupt);
  expect((await adapter().open()).ok).toBe(false);
  expect(readFileSync(file)).toEqual(corrupt);
});
it("refuses plaintext and unavailable locations rather than selecting another adapter", async () => {
  writeFileSync(file, "SQLite format 3\0" + "synthetic plaintext".repeat(20));
  expect((await adapter().open()).ok).toBe(false);
  const missing = new SecureStorage(
    join(directory, "missing", "history.sqlite"),
    key,
  );
  adapters.push(missing);
  expect((await missing.open()).ok).toBe(false);
  expect(() => missing.repositories).toThrow();
  expect(existsSync(join(directory, "missing"))).toBe(false);
});
it.each(["checksum", "future"])(
  "refuses %s migration metadata without overwriting it",
  async (kind) => {
    const first = adapter();
    await populate(first);
    await first.close();
    const db = inspect();
    if (kind === "checksum")
      db.exec(
        "UPDATE rewind_migrations SET checksum='invalid' WHERE version=1",
      );
    else
      db.exec(
        "INSERT INTO rewind_migrations VALUES (999,'future','synthetic')",
      );
    db.close();
    expect((await adapter().open()).ok).toBe(false);
    const verify = inspect();
    try {
      expect(
        verify.prepare("SELECT COUNT(*) AS count FROM activities").get(),
      ).toEqual({ count: 1 });
    } finally {
      verify.close();
    }
  },
);
it("keeps timeline date/session/type/search filters scoped and deterministic", async () => {
  const storage = adapter();
  await populate(storage);
  await storage.repositories.activities.append([
    {
      id: "10000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      occurredAt: session.startedAt,
      type: "capture-gap",
      source: "rewind",
      payload: { collectorId: "synthetic", reason: "unavailable" },
    },
  ]);
  const first = await storage.timeline({ limit: 1 });
  expect(first.ok && first.value[0]?.type).toBe("capture-gap");
  if (!first.ok || !first.value[0]) throw new Error("Expected page");
  const next = await storage.timeline({
    limit: 1,
    before: { id: first.value[0].id, occurredAt: first.value[0].occurredAt },
  });
  expect(next.ok && next.value[0]?.type).toBe("foreground");
  expect(
    await storage.timeline({
      limit: 10,
      sessionId: "00000000-0000-4000-8000-000000000099",
    }),
  ).toEqual({ ok: true, value: [] });
  expect(
    await storage.timeline({ limit: 10, from: "2026-11-18T10:00:00.000Z" }),
  ).toEqual({ ok: true, value: [] });
  expect(await storage.timeline({ limit: 10, text: '" OR * --' })).toEqual({
    ok: true,
    value: [],
  });
  const foreground = await storage.timeline({
    limit: 10,
    types: ["foreground"],
  });
  expect(foreground.ok && foreground.value).toHaveLength(1);
});
