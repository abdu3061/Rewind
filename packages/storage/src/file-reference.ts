import type { DatabaseConnection } from "./database";
import type { FileReference } from "@rewind/contracts";

/** Shared synchronous write so references and observations can share an owned transaction. */
export function writeFileReference(
  db: DatabaseConnection,
  file: FileReference,
): void {
  db.prepare(
    `
    INSERT INTO files (id, display_name, identity_kind, absolute_path, verified_at, observed_title)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name, identity_kind = excluded.identity_kind,
      absolute_path = excluded.absolute_path, verified_at = excluded.verified_at,
      observed_title = excluded.observed_title
  `,
  ).run(
    file.id,
    file.displayName,
    file.identity.kind,
    file.identity.kind === "verified-path" ? file.identity.absolutePath : null,
    file.identity.kind === "verified-path" ? file.identity.verifiedAt : null,
    file.identity.kind === "unverified" ? file.identity.observedTitle : null,
  );
}
