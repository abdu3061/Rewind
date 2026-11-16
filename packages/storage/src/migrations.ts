import { createHash } from "node:crypto";
import initial from "../../../db/migrations/001_initial.sql?raw";
import recording from "../../../db/migrations/002_recording.sql?raw";
import type { DatabaseConnection } from "./database";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}
export const secureMigrations: readonly Migration[] = [
  { version: 1, name: "initial", sql: initial },
  { version: 2, name: "recording", sql: recording },
];
export function applySecureMigrations(
  db: DatabaseConnection,
  migrations = secureMigrations,
): void {
  if (migrations.some((migration, index) => migration.version !== index + 1))
    throw new Error("MIGRATION_ORDER_INVALID");
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  if (
    tables.length &&
    !tables.some((table) => table.name === "rewind_migrations")
  )
    throw new Error("UNRECOGNIZED_SCHEMA");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS rewind_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL)",
    );
    const applied = db
      .prepare(
        "SELECT version, name, checksum FROM rewind_migrations ORDER BY version",
      )
      .all() as { version: number; name: string; checksum: string }[];
    if (applied.length > migrations.length) throw new Error("FUTURE_SCHEMA");
    for (const [index, migration] of migrations.entries()) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const previous = applied[index];
      if (previous) {
        if (
          previous.version !== migration.version ||
          previous.name !== migration.name ||
          previous.checksum !== checksum
        )
          throw new Error("MIGRATION_INTEGRITY_FAILED");
      } else {
        db.exec(migration.sql);
        db.prepare(
          "INSERT INTO rewind_migrations (version, name, checksum) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, checksum);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* Caller closes the unusable handle. */
    }
    throw error;
  }
}
