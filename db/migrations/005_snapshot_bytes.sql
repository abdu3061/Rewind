CREATE TABLE protected_folders (
  id TEXT PRIMARY KEY,
  absolute_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  selected_at TEXT NOT NULL,
  os_identity TEXT NOT NULL
);
CREATE TABLE snapshot_blobs (
  content_hash TEXT PRIMARY KEY CHECK(length(content_hash)=64),
  bytes BLOB NOT NULL CHECK(length(bytes)<=16777216)
);
CREATE TRIGGER snapshot_blob_immutable BEFORE UPDATE ON snapshot_blobs
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_SNAPSHOT'); END;
ALTER TABLE file_versions ADD COLUMN blob_hash TEXT REFERENCES snapshot_blobs(content_hash) ON DELETE RESTRICT
  CHECK(blob_hash IS NULL OR blob_hash=content_hash);
ALTER TABLE file_versions ADD COLUMN os_identity TEXT;
CREATE TABLE file_bindings (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES protected_folders(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL COLLATE NOCASE,
  os_identity TEXT NOT NULL,
  UNIQUE(folder_id, relative_path)
);
CREATE INDEX idx_snapshot_history ON file_versions(captured_at DESC, id DESC) WHERE blob_hash IS NOT NULL;
