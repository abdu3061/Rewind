import NativeDatabase from "better-sqlite3-multiple-ciphers";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  activityEventSchema,
  createDefaultSettings,
  failure,
  historyQuerySchema,
  sessionSchema,
  timelineQuerySchema,
  userSettingsSchema,
  sanitizeBrowserMetadataUrl,
  type ActivityEvent,
  type HistoryQuery,
  type Repositories,
  type Result,
  type Session,
  type SessionStorage,
  type TimelineQuery,
  type UserSettings,
  type DeleteHistory,
  type StorageUsage,
} from "@rewind/contracts";
import { StorageMaintenance } from "./storage-maintenance";
import {
  SnapshotRepository,
  verifySnapshotSchema,
} from "./snapshot-repository";
import type { DatabaseConnection, SqlValue } from "./database";
import { createRepositories, verifyRepositorySchema } from "./repositories";
import { SqliteCheckpointRepository } from "./checkpoint-repository";
import { SqliteActivityRepository } from "./activity-repository";
import { applySecureMigrations } from "./migrations";
import {
  BrowserSetupRepository,
  verifyBrowserSetupJournal,
} from "./browser-setup-repository";
import {
  AssistantCredentialRepository,
  verifyAssistantCredential,
} from "./assistant-credential-repository";

type Native = InstanceType<typeof NativeDatabase>;
const ok = (): Result<void> => ({ ok: true, value: undefined });
function connection(db: Native): DatabaseConnection {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare<SqlValue[], Record<string, unknown>>(sql),
    get isTransaction() {
      return db.inTransaction;
    },
  };
}
function ciphertextHeader(file: string): boolean {
  const handle = openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    const size = readSync(handle, header, 0, 16, 0);
    return size === 16 && !header.equals(Buffer.from("SQLite format 3\0"));
  } finally {
    closeSync(handle);
  }
}

/** SQLCipher-profile encrypted metadata. Never opens plaintext/memory as a fallback. */
export class SecureStorage implements SessionStorage {
  private db: Native | null = null;
  private repositorySet: Repositories | null = null;
  private terminal = false;
  private readonly key: Buffer;
  constructor(
    private readonly file: string,
    key: Uint8Array,
  ) {
    this.key = Buffer.from(key);
  }
  get repositories(): Repositories {
    if (!this.repositorySet) throw new Error("SECURE_STORAGE_UNAVAILABLE");
    return this.repositorySet;
  }
  get checkpoints(): SqliteCheckpointRepository {
    if (!this.repositorySet || !this.db)
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
    return new SqliteCheckpointRepository(connection(this.db));
  }
  get browserSetup(): BrowserSetupRepository {
    if (!this.repositorySet || !this.db)
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
    return new BrowserSetupRepository(connection(this.db));
  }
  get assistantCredential(): AssistantCredentialRepository {
    if (!this.repositorySet || !this.db)
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
    return new AssistantCredentialRepository(connection(this.db));
  }
  get evidence(): SqliteActivityRepository {
    if (!this.repositorySet || !this.db)
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
    return new SqliteActivityRepository(connection(this.db));
  }
  get snapshots(): SnapshotRepository {
    if (!this.repositorySet || !this.db)
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
    const db = this.db;
    return new SnapshotRepository(
      connection(db),
      (settings) =>
        new StorageMaintenance(db, this.file).usage(settings).totalBytes,
    );
  }
  async open(): Promise<Result<void>> {
    if (this.repositorySet) return ok();
    if (this.terminal)
      return failure("UNAVAILABLE", "Secure storage is closed.");
    if (this.key.length !== 32 || !isAbsolute(this.file))
      return failure(
        "INVALID_INPUT",
        "Secure storage requires a protected key and an absolute database location.",
      );
    let stage = "location";
    try {
      if (existsSync(this.file)) {
        const info = lstatSync(this.file);
        if (
          info.isSymbolicLink() ||
          !info.isFile() ||
          (info.size > 0 && !ciphertextHeader(this.file))
        )
          throw new Error("UNVERIFIED_DATABASE");
      }
      const db = new NativeDatabase(this.file, { timeout: 1000 });
      this.db = db;
      stage = "cipher-profile";
      db.pragma("cipher=sqlcipher");
      db.pragma("legacy=4");
      db.key(this.key);
      stage = "authentication";
      // Keying precedes every prepared statement, including capability/configuration queries.
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      stage = "cipher-profile";
      for (const [parameter, expected] of [
        ["hmac_use", 1],
        ["hmac_algorithm", 2],
        ["kdf_algorithm", 2],
        ["kdf_iter", 256000],
        ["plaintext_header_size", 0],
      ] as const) {
        if (
          db
            .prepare<[string, string], { value: number }>(
              "SELECT sqlite3mc_config(?, ?) AS value",
            )
            .get("sqlcipher", parameter)?.value !== expected
        )
          throw new Error("CIPHER_PROFILE_UNAVAILABLE");
      }
      const version = db
        .prepare("SELECT sqlite3mc_version() AS version")
        .get() as { version: unknown };
      if (version.version !== "SQLite3 Multiple Ciphers 2.7.0")
        throw new Error("CIPHER_BUILD_UNVERIFIED");
      db.pragma("foreign_keys=ON");
      db.pragma("temp_store=MEMORY");
      db.pragma("secure_delete=ON");
      db.pragma("journal_mode=WAL");
      db.pragma("synchronous=FULL");
      db.pragma("wal_autocheckpoint=256");
      db.pragma("max_page_count=524288");
      if (
        db.pragma("temp_store", { simple: true }) !== 2 ||
        db.pragma("foreign_keys", { simple: true }) !== 1
      )
        throw new Error("STORAGE_POLICY_UNAVAILABLE");
      stage = "migration";
      applySecureMigrations(connection(db));
      verifyRepositorySchema(connection(db));
      verifySnapshotSchema(connection(db));
      verifyBrowserSetupJournal(connection(db));
      verifyAssistantCredential(connection(db));
      db.prepare("SELECT id, payload FROM runtime_settings LIMIT 0").all();
      db.prepare("SELECT rowid, text FROM activity_fts LIMIT 0").all();
      const triggers = db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('activity_fts_insert','activity_fts_delete','activity_fts_update')",
        )
        .get() as { count: number };
      if (triggers.count !== 3) throw new Error("INDEX_SCHEMA_INCOMPLETE");
      stage = "integrity";
      const integrity = db.pragma("integrity_check") as {
        integrity_check: string;
      }[];
      const foreignKeys = db.pragma("foreign_key_check");
      if (
        integrity.length !== 1 ||
        integrity[0]?.integrity_check !== "ok" ||
        !Array.isArray(foreignKeys) ||
        foreignKeys.length !== 0 ||
        !ciphertextHeader(this.file)
      )
        throw new Error("STORAGE_INTEGRITY_FAILED");
      db.exec(
        "INSERT INTO activity_fts(activity_fts, rank) VALUES ('integrity-check', 1)",
      );
      this.repositorySet = createRepositories(connection(db));
      stage = "settings";
      const defaults = userSettingsSchema.parse(createDefaultSettings());
      db.prepare(
        "INSERT INTO runtime_settings (id, payload) VALUES (1, ?) ON CONFLICT(id) DO NOTHING",
      ).run(JSON.stringify(defaults));
      const settings = await this.getSettings();
      if (!settings.ok) throw new Error("SETTINGS_INTEGRITY_FAILED");
      return ok();
    } catch {
      this.repositorySet = null;
      try {
        this.db?.close();
        this.db = null;
      } catch {
        /* close can be retried without exposing repositories. */
      }
      return failure(
        "UNAVAILABLE",
        `Encrypted storage could not be verified (${stage}). No recording was enabled.`,
      );
    }
  }
  async close(): Promise<Result<void>> {
    this.terminal = true;
    this.repositorySet = null;
    this.key.fill(0);
    try {
      if (this.db?.open) this.db.close();
      this.db = null;
      return ok();
    } catch {
      return failure("UNAVAILABLE", "Encrypted storage did not close cleanly.");
    }
  }
  async getSettings(): Promise<Result<UserSettings>> {
    if (!this.repositorySet || !this.db)
      return failure("UNAVAILABLE", "Secure storage is unavailable.");
    try {
      const row = this.db
        .prepare("SELECT payload FROM runtime_settings WHERE id=1")
        .get() as { payload: string } | undefined;
      const parsed = userSettingsSchema.safeParse(
        row ? JSON.parse(row.payload) : null,
      );
      return parsed.success
        ? { ok: true, value: parsed.data }
        : failure("INTEGRITY_FAILURE", "Stored settings are invalid.");
    } catch {
      return failure("INTEGRITY_FAILURE", "Stored settings are unavailable.");
    }
  }
  async saveSettings(settings: UserSettings): Promise<Result<void>> {
    const parsed = userSettingsSchema.safeParse(settings);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Collection settings are invalid.");
    if (!this.repositorySet || !this.db)
      return failure("UNAVAILABLE", "Secure storage is unavailable.");
    try {
      const saved = this.db
        .prepare("UPDATE runtime_settings SET payload=? WHERE id=1")
        .run(JSON.stringify(parsed.data));
      return saved.changes === 1
        ? ok()
        : failure("INTEGRITY_FAILURE", "Collection settings were not saved.");
    } catch {
      return failure("UNAVAILABLE", "Collection settings were not saved.");
    }
  }
  async history(query: HistoryQuery): Promise<Result<Session[]>> {
    const parsed = historyQuerySchema.safeParse(query);
    if (!parsed.success)
      return failure("INVALID_INPUT", "History query is invalid.");
    if (!this.repositorySet || !this.db)
      return failure("UNAVAILABLE", "Secure storage is unavailable.");
    query = parsed.data;
    try {
      const params: SqlValue[] = [];
      let filter = "";
      if (query.before) {
        filter = "WHERE started_at < ? OR (started_at = ? AND id < ?)";
        params.push(
          query.before.startedAt,
          query.before.startedAt,
          query.before.id,
        );
      }
      params.push(query.limit);
      const rows = this.db
        .prepare(
          `SELECT id, status, started_at, updated_at, ended_at FROM sessions ${filter} ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(...params) as {
        id: string;
        status: string;
        started_at: string;
        updated_at: string;
        ended_at: string | null;
      }[];
      const sessions = rows.map((row) =>
        sessionSchema.parse({
          id: row.id,
          status: row.status,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          endedAt: row.ended_at,
        }),
      );
      return { ok: true, value: sessions };
    } catch {
      return failure("INTEGRITY_FAILURE", "Stored history is unavailable.");
    }
  }
  async timeline(query: TimelineQuery): Promise<Result<ActivityEvent[]>> {
    const parsed = timelineQuerySchema.safeParse(query);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Timeline query is invalid.");
    if (!this.repositorySet || !this.db)
      return failure("UNAVAILABLE", "Secure storage is unavailable.");
    query = parsed.data;
    try {
      const conditions = [
        "a.type IN ('foreground', 'capture-gap', 'file-change', 'browser-visit')",
      ];
      const params: SqlValue[] = [];
      if (query.sessionId) {
        conditions.push("a.session_id=?");
        params.push(query.sessionId);
      }
      if (query.from) {
        conditions.push("a.occurred_at>=?");
        params.push(query.from);
      }
      if (query.to) {
        conditions.push("a.occurred_at<=?");
        params.push(query.to);
      }
      if (query.before) {
        conditions.push(
          "(a.occurred_at < ? OR (a.occurred_at = ? AND a.id < ?))",
        );
        params.push(
          query.before.occurredAt,
          query.before.occurredAt,
          query.before.id,
        );
      }
      if (query.types) {
        conditions.push(`a.type IN (${query.types.map(() => "?").join(",")})`);
        params.push(...query.types);
      }
      if (query.text) {
        const terms = query.text.match(/[\p{L}\p{N}_]+/gu) ?? [];
        if (terms.length > 30)
          return failure("INVALID_INPUT", "Use at most 30 search terms.");
        if (!terms.length) return { ok: true, value: [] };
        conditions.push(
          "a.rowid IN (SELECT rowid FROM activity_fts WHERE activity_fts MATCH ?)",
        );
        params.push(
          terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "),
        );
      }
      params.push(query.limit);
      const rows = this.db
        .prepare(
          `SELECT a.id, a.session_id, a.occurred_at, a.type, a.source, CASE WHEN a.type='browser-visit' THEN json_remove(a.payload,'$.articleText') ELSE a.payload END AS payload FROM activities a WHERE ${conditions.join(" AND ")} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`,
        )
        .all(...params) as {
        id: string;
        session_id: string;
        occurred_at: string;
        type: string;
        source: string;
        payload: string;
      }[];
      return {
        ok: true,
        value: rows.map((row) => {
          const event = activityEventSchema.parse({
            id: row.id,
            sessionId: row.session_id,
            occurredAt: row.occurred_at,
            type: row.type,
            source: row.source,
            payload: JSON.parse(row.payload),
          });
          if (event.type === "browser-visit") {
            const url = sanitizeBrowserMetadataUrl(event.payload.url, []);
            if (!url) throw new Error("BROWSER_HISTORY_URL_INVALID");
            event.payload.url = url;
          }
          return event;
        }),
      };
    } catch {
      return failure("INTEGRITY_FAILURE", "Stored timeline is unavailable.");
    }
  }
  async recoverInterrupted(now: string): Promise<Result<void>> {
    const latest = await this.repositories.sessions.getLatest();
    if (!latest.ok) return latest;
    if (latest.value?.status === "active") {
      return this.repositories.activities.append([
        {
          id: randomUUID(),
          sessionId: latest.value.id,
          occurredAt:
            now < latest.value.updatedAt ? latest.value.updatedAt : now,
          type: "capture-gap",
          source: "rewind",
          payload: { collectorId: "runtime", reason: "unavailable" },
        },
      ]);
    }
    return ok();
  }
  async usage(): Promise<Result<StorageUsage>> {
    const settings = await this.getSettings();
    if (!settings.ok) return settings;
    try {
      return {
        ok: true,
        value: new StorageMaintenance(this.db!, this.file).usage(
          settings.value,
        ),
      };
    } catch {
      return failure("UNAVAILABLE", "Storage usage could not be verified.");
    }
  }
  async cleanup(now = new Date()): Promise<Result<StorageUsage>> {
    const settings = await this.getSettings();
    return settings.ok
      ? new StorageMaintenance(this.db!, this.file).cleanup(settings.value, now)
      : settings;
  }
  async deleteHistory(input: DeleteHistory): Promise<Result<StorageUsage>> {
    const settings = await this.getSettings();
    return settings.ok
      ? new StorageMaintenance(this.db!, this.file).delete(
          settings.value,
          input,
        )
      : settings;
  }
}
