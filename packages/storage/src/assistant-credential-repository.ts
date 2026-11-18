import {
  assistantCredentialSchema,
  geminiApiKeySchema,
  timestampSchema,
  failure,
  type AssistantCredential,
  type Result,
} from "@rewind/contracts";
import type { DatabaseConnection } from "./database";

function stored(db: DatabaseConnection): AssistantCredential {
  const rows = db
    .prepare(
      `SELECT id,revision,
    CASE WHEN api_key IS NULL OR (typeof(api_key)='text' AND length(CAST(api_key AS BLOB)) BETWEEN 16 AND 512) THEN 1 ELSE 0 END AS valid_key,
    CASE WHEN length(CAST(api_key AS BLOB))<=512 THEN api_key ELSE NULL END AS api_key,
    CASE WHEN updated_at IS NULL OR (typeof(updated_at)='text' AND length(updated_at)=24) THEN 1 ELSE 0 END AS valid_time,
    CASE WHEN length(updated_at)=24 THEN updated_at ELSE NULL END AS updated_at
    FROM assistant_credential LIMIT 2`,
    )
    .all() as Record<string, unknown>[];
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.id !== 1 ||
    row.valid_key !== 1 ||
    row.valid_time !== 1
  )
    throw new Error("ASSISTANT_CREDENTIAL_INVALID");
  return assistantCredentialSchema.parse({
    revision: row.revision,
    apiKey: row.api_key,
    updatedAt: row.updated_at,
  });
}
export function verifyAssistantCredential(db: DatabaseConnection): void {
  stored(db);
}

/** Utility-only operational secret in the existing cipher database; never included in public DTOs. */
export class AssistantCredentialRepository {
  constructor(private readonly db: DatabaseConnection) {}
  async read(): Promise<Result<AssistantCredential>> {
    try {
      return { ok: true, value: stored(this.db) };
    } catch {
      return failure(
        "INTEGRITY_FAILURE",
        "The private assistant credential could not be verified.",
      );
    }
  }
  async write(
    expectedRevision: number,
    apiKey: string | null,
    updatedAt: string,
  ): Promise<Result<void>> {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER - 1 ||
      !geminiApiKeySchema.nullable().safeParse(apiKey).success ||
      !timestampSchema.safeParse(updatedAt).success
    )
      return failure(
        "INVALID_INPUT",
        "The private credential update is invalid.",
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
      const previous = stored(this.db);
      if (previous.revision !== expectedRevision) {
        this.db.exec("ROLLBACK");
        started = false;
        return failure(
          "CONFLICT",
          "The private credential changed. Review configuration again.",
        );
      }
      const result = this.db
        .prepare(
          "UPDATE assistant_credential SET revision=?,api_key=?,updated_at=? WHERE id=1 AND revision=?",
        )
        .run(expectedRevision + 1, apiKey, updatedAt, expectedRevision);
      const saved = stored(this.db);
      if (
        result.changes !== 1 ||
        saved.revision !== expectedRevision + 1 ||
        saved.apiKey !== apiKey ||
        saved.updatedAt !== updatedAt
      )
        throw new Error("ASSISTANT_CREDENTIAL_UNCONFIRMED");
      this.db.exec("COMMIT");
      started = false;
      return { ok: true, value: undefined };
    } catch {
      if (started)
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* Storage composition reports failure and stops reuse. */
        }
      return failure(
        "UNAVAILABLE",
        "The private assistant credential update was not confirmed.",
      );
    }
  }
}
