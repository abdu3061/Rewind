import {
  browserSetupJournalSchema,
  failure,
  type BrowserSetupJournal,
  type BrowserSetupStore,
  type Result,
} from "@rewind/contracts";
import type { DatabaseConnection } from "./database";

const maxBytes = 262144;
function stored(db: DatabaseConnection): BrowserSetupJournal {
  const rows = db
    .prepare(
      `SELECT id,revision,
    CASE WHEN length(CAST(payload AS BLOB))<=${maxBytes} THEN payload ELSE NULL END AS payload
    FROM browser_setup_journal LIMIT 2`,
    )
    .all() as Record<string, unknown>[];
  const row = rows[0];
  if (rows.length !== 1 || row?.id !== 1 || typeof row.payload !== "string")
    throw new Error("SETUP_JOURNAL_INVALID");
  const result = browserSetupJournalSchema.parse(JSON.parse(row.payload));
  if (result.revision !== row.revision)
    throw new Error("SETUP_JOURNAL_REVISION_INVALID");
  return result;
}
export function verifyBrowserSetupJournal(db: DatabaseConnection): void {
  stored(db);
}

/** Encrypted ownership journal; called on the utility storage queue, before registry mutations. */
export class BrowserSetupRepository implements BrowserSetupStore {
  constructor(private readonly db: DatabaseConnection) {}
  async read(): Promise<Result<BrowserSetupJournal>> {
    try {
      return { ok: true, value: stored(this.db) };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "Browser setup ownership could not be verified.",
      );
    }
  }
  async write(
    expectedRevision: number,
    next: BrowserSetupJournal,
  ): Promise<Result<void>> {
    const parsed = browserSetupJournalSchema.safeParse(next);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !parsed.success ||
      parsed.data.revision !== expectedRevision + 1 ||
      Buffer.byteLength(JSON.stringify(parsed.data)) > maxBytes
    )
      return failure(
        "INVALID_INPUT",
        "Browser setup ownership update is invalid.",
      );
    let started = false;
    try {
      if (this.db.isTransaction)
        return failure(
          "CONFLICT",
          "A storage transaction is already in progress.",
        );
      this.db.exec("BEGIN IMMEDIATE");
      started = true;
      const current = stored(this.db);
      if (current.revision !== expectedRevision) {
        this.db.exec("ROLLBACK");
        started = false;
        return failure(
          "CONFLICT",
          "Browser setup ownership changed. Inspect setup before retrying.",
        );
      }
      if (
        parsed.data.generations.length < current.generations.length ||
        current.generations.some(
          (item, index) =>
            JSON.stringify(item) !==
            JSON.stringify(parsed.data.generations[index]),
        )
      ) {
        this.db.exec("ROLLBACK");
        started = false;
        return failure(
          "INVALID_INPUT",
          "Existing browser setup ownership receipts cannot be replaced or removed.",
        );
      }
      const payload = JSON.stringify(parsed.data);
      const result = this.db
        .prepare(
          "UPDATE browser_setup_journal SET revision=?,payload=? WHERE id=1 AND revision=?",
        )
        .run(parsed.data.revision, payload, expectedRevision);
      if (result.changes !== 1 || JSON.stringify(stored(this.db)) !== payload)
        throw new Error("SETUP_JOURNAL_WRITE_UNCONFIRMED");
      this.db.exec("COMMIT");
      started = false;
      return { ok: true, value: undefined };
    } catch {
      if (started)
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* Caller stops maintenance on failure. */
        }
      return failure(
        "UNAVAILABLE",
        "Browser setup ownership was not confirmed. No new registration is authorized.",
      );
    }
  }
}
