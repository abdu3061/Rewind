import type { Repositories } from "@rewind/contracts";
import type { DatabaseConnection } from "./database";
import { SqliteActivityRepository } from "./activity-repository";
import { SqliteCheckpointRepository } from "./checkpoint-repository";
import { SqliteFileRepository } from "./file-repository";
import { SqliteSearchRepository } from "./search-repository";
import { SqliteSessionRepository } from "./session-repository";
export function createRepositories(db: DatabaseConnection): Repositories {
  return {
    sessions: new SqliteSessionRepository(db),
    activities: new SqliteActivityRepository(db),
    files: new SqliteFileRepository(db),
    checkpoints: new SqliteCheckpointRepository(db),
    search: new SqliteSearchRepository(db),
  };
}
export function verifyRepositorySchema(db: DatabaseConnection): void {
  for (const query of [
    "SELECT id, status, started_at, updated_at, ended_at FROM sessions LIMIT 0",
    "SELECT id, session_id, type, source, occurred_at, payload FROM activities LIMIT 0",
    "SELECT id, display_name, identity_kind, absolute_path, verified_at, observed_title FROM files LIMIT 0",
    "SELECT id, session_id, file_id, captured_at, content_hash, byte_length, media_type FROM file_versions LIMIT 0",
    "SELECT id, session_id, name, created_at, kept, project_references FROM checkpoints LIMIT 0",
    "SELECT checkpoint_id, file_version_id FROM checkpoint_file_versions LIMIT 0",
    "SELECT checkpoint_id, browser_visit_id FROM checkpoint_browser_visits LIMIT 0",
  ])
    db.prepare(query).all();
}
