import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { applySecureMigrations } from "./migrations";
it("rolls back a failed upgrade and preserves the previous applied version", () => {
  const db = new DatabaseSync(":memory:");
  const first = {
    version: 1,
    name: "synthetic",
    sql: "CREATE TABLE fixture (id TEXT);",
  };
  try {
    applySecureMigrations(db, [first]);
    expect(() =>
      applySecureMigrations(db, [
        first,
        {
          version: 2,
          name: "failed",
          sql: "CREATE TABLE partial (id TEXT); INVALID SQL;",
        },
      ]),
    ).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM rewind_migrations").get()
        ?.count,
    ).toBe(1);
    expect(() =>
      applySecureMigrations(db, [{ ...first, sql: "different" }]),
    ).toThrow();
    expect(() =>
      applySecureMigrations(db, [{ ...first, version: 2 }]),
    ).toThrow();
  } finally {
    db.close();
  }
});
