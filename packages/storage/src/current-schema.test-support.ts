import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { secureMigrations } from "./migrations";
import {
  newSecureFixture,
  removeSecureFixture,
} from "./secure-fixtures.test-support";

/** Current SQL only for the explicitly synthetic plaintext adapter. Never a production fallback. */
export function currentSchemaFixture() {
  const root = newSecureFixture(),
    path = join(root, "synthetic-schema.sql");
  writeFileSync(
    path,
    secureMigrations.map((migration) => migration.sql).join("\n"),
  );
  return { path, remove: () => removeSecureFixture(root) };
}
