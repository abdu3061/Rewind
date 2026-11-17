import { existsSync, lstatSync } from "node:fs";
import type NativeDatabase from "better-sqlite3-multiple-ciphers";
import {
  deleteHistorySchema,
  failure,
  storageUsageSchema,
  type DeleteHistory,
  type Result,
  type StorageUsage,
  type UserSettings,
} from "@rewind/contracts";

type Native = InstanceType<typeof NativeDatabase>;
const unlinkedVersion =
  "id NOT IN (SELECT file_version_id FROM checkpoint_file_versions)";
const unlinkedActivity =
  "id NOT IN (SELECT browser_visit_id FROM checkpoint_browser_visits) AND id NOT IN (SELECT activity_id FROM checkpoint_activities)";

/** Runs only on the worker's serialized storage queue, never against caller-owned transactions. */
export class StorageMaintenance {
  constructor(
    private readonly db: Native,
    private readonly file: string,
  ) {}

  usage(settings: UserSettings): StorageUsage {
    const size = (suffix: string) => {
      const name = this.file + suffix;
      if (!existsSync(name)) return 0;
      const stat = lstatSync(name);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("STORAGE_LOCATION_CHANGED");
      return stat.size;
    };
    const databaseBytes = size("");
    const journalBytes = size("-wal") + size("-shm");
    const counts = this.db
      .prepare(
        `SELECT
      (SELECT count(*) FROM activities) AS activityCount,
      (SELECT count(*) FROM file_versions) AS versionCount,
      (SELECT count(*) FROM checkpoints) AS checkpointCount,
      (SELECT count(*) FROM checkpoints WHERE kept=1) AS keptCheckpointCount`,
      )
      .get() as Record<string, number>;
    return storageUsageSchema.parse({
      ...counts,
      databaseBytes,
      journalBytes,
      totalBytes: databaseBytes + journalBytes,
      overQuota: databaseBytes + journalBytes > settings.storageLimitBytes,
      preferences: {
        retentionHours: settings.retentionHours,
        storageLimitBytes: settings.storageLimitBytes,
      },
    });
  }

  private transaction(operation: () => void): void {
    this.db.transaction(operation).immediate();
  }
  private removeOrphans(): void {
    this.db.exec(
      "DELETE FROM snapshot_blobs WHERE content_hash NOT IN (SELECT blob_hash FROM file_versions WHERE blob_hash IS NOT NULL)",
    );
    this.db
      .exec(`DELETE FROM files WHERE id NOT IN (SELECT file_id FROM file_versions)
      AND id NOT IN (SELECT json_extract(payload,'$.id') FROM activities WHERE type='file-opened')
      AND id NOT IN (SELECT json_extract(payload,'$.fileId') FROM activities WHERE type='file-change')`);
  }
  private compact(vacuum: boolean): void {
    const result = this.db.pragma("wal_checkpoint(TRUNCATE)") as {
      busy: number;
    }[];
    if (result.some((row) => row.busy !== 0))
      throw new Error("STORAGE_CHECKPOINT_BUSY");
    if (vacuum) {
      this.db.exec("VACUUM");
      const after = this.db.pragma("wal_checkpoint(TRUNCATE)") as {
        busy: number;
      }[];
      if (after.some((row) => row.busy !== 0))
        throw new Error("STORAGE_CHECKPOINT_BUSY");
    }
  }
  cleanup(settings: UserSettings, now: Date): Result<StorageUsage> {
    try {
      const cutoff = new Date(
        now.getTime() - settings.retentionHours * 3600_000,
      ).toISOString();
      let changed = 0;
      this.transaction(() => {
        changed += this.db
          .prepare("DELETE FROM checkpoints WHERE kept=0 AND created_at < ?")
          .run(cutoff).changes;
        changed += this.db
          .prepare(
            `DELETE FROM activities WHERE occurred_at < ? AND ${unlinkedActivity}`,
          )
          .run(cutoff).changes;
        changed += this.db
          .prepare(
            `DELETE FROM file_versions WHERE captured_at < ? AND ${unlinkedVersion}`,
          )
          .run(cutoff).changes;
        this.removeOrphans();
      });
      this.compact(changed > 0);
      // Bounded oldest-first eviction. Kept checkpoints and all their transitive evidence survive.
      for (
        let round = 0;
        this.usage(settings).overQuota && round < 3;
        round++
      ) {
        const usage = this.usage(settings);
        const fraction = Math.min(
          1,
          (1 - settings.storageLimitBytes / usage.totalBytes) * 1.25,
        );
        const activityLimit = Math.min(
          5000,
          Math.max(500, Math.ceil(usage.activityCount * fraction)),
        );
        const versionLimit = Math.min(
          500,
          Math.max(100, Math.ceil(usage.versionCount * fraction)),
        );
        let removed = 0;
        this.transaction(() => {
          removed += this.db
            .prepare(
              "DELETE FROM checkpoints WHERE id IN (SELECT id FROM checkpoints WHERE kept=0 ORDER BY created_at,id LIMIT 100)",
            )
            .run().changes;
          removed += this.db
            .prepare(
              `DELETE FROM activities WHERE id IN (SELECT id FROM activities WHERE ${unlinkedActivity} ORDER BY occurred_at,id LIMIT ?)`,
            )
            .run(activityLimit).changes;
          removed += this.db
            .prepare(
              `DELETE FROM file_versions WHERE id IN (SELECT id FROM file_versions WHERE ${unlinkedVersion} ORDER BY captured_at,id LIMIT ?)`,
            )
            .run(versionLimit).changes;
          this.removeOrphans();
        });
        this.compact(true);
        if (!removed) break;
      }
      return { ok: true, value: this.usage(settings) };
    } catch {
      return failure(
        "UNAVAILABLE",
        "Storage cleanup could not be verified. Recording must remain stopped.",
      );
    }
  }
  delete(settings: UserSettings, input: DeleteHistory): Result<StorageUsage> {
    const parsed = deleteHistorySchema.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "Confirmed deletion is required.");
    try {
      const query = parsed.data;
      const scope = query.sessionId ? "session_id = ? AND " : "";
      const args = query.sessionId ? [query.sessionId] : [];
      this.transaction(() => {
        this.db
          .prepare(
            `DELETE FROM checkpoints WHERE ${scope}${query.includeKept ? "1=1" : "kept=0"}`,
          )
          .run(...args);
        this.db
          .prepare(`DELETE FROM activities WHERE ${scope}${unlinkedActivity}`)
          .run(...args);
        this.db
          .prepare(`DELETE FROM file_versions WHERE ${scope}${unlinkedVersion}`)
          .run(...args);
        this.removeOrphans();
      });
      this.compact(true);
      return { ok: true, value: this.usage(settings) };
    } catch {
      return failure(
        "UNAVAILABLE",
        "History deletion could not be fully verified. Some logical deletion may have committed; retry cleanup.",
      );
    }
  }
}
