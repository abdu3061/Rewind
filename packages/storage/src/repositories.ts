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
    "SELECT checkpoint_id, activity_id FROM checkpoint_activities LIMIT 0",
  ])
    db.prepare(query).all();
  const guards = db
    .prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND name IN ('checkpoint_visit_membership','checkpoint_version_membership','checkpoint_activity_membership')",
    )
    .get();
  if (guards?.count !== 3) throw new Error("CHECKPOINT_GUARDS_UNAVAILABLE");
  for (const query of [
    "SELECT 1 AS invalid FROM checkpoint_activities m JOIN activities a ON a.id=m.activity_id JOIN checkpoints c ON c.id=m.checkpoint_id WHERE a.session_id!=c.session_id LIMIT 1",
    "SELECT 1 AS invalid FROM checkpoint_file_versions m JOIN file_versions v ON v.id=m.file_version_id JOIN checkpoints c ON c.id=m.checkpoint_id WHERE v.session_id!=c.session_id LIMIT 1",
    "SELECT 1 AS invalid FROM checkpoint_browser_visits m JOIN activities a ON a.id=m.browser_visit_id JOIN checkpoints c ON c.id=m.checkpoint_id WHERE a.session_id!=c.session_id OR a.type!='browser-visit' LIMIT 1",
    "SELECT 1 AS invalid FROM checkpoints WHERE kept NOT IN (0,1) LIMIT 1",
    "SELECT 1 AS invalid FROM checkpoint_browser_visits b LEFT JOIN checkpoint_activities a ON a.checkpoint_id=b.checkpoint_id AND a.activity_id=b.browser_visit_id WHERE a.activity_id IS NULL LIMIT 1",
  ])
    if (db.prepare(query).get())
      throw new Error("CHECKPOINT_EVIDENCE_INTEGRITY");
}
