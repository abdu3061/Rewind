-- Canonical Schema for Rewind Database
PRAGMA foreign_keys = ON;

-- 0. Schema Migrations Table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

-- 1. Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at 
ON sessions (started_at DESC);

-- 2. Activity Events Table
CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activities_session 
ON activities (session_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_activities_session_type 
ON activities (session_id, type, occurred_at);

CREATE INDEX IF NOT EXISTS idx_activities_occurred_at 
ON activities (occurred_at DESC);

-- 3. Files Table
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('verified-path', 'unverified')),
    absolute_path TEXT,
    verified_at TEXT,
    observed_title TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_display_name 
ON files (display_name);

-- 4. File Versions Table (Snapshots)
CREATE TABLE IF NOT EXISTS file_versions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_versions_file 
ON file_versions (file_id, captured_at);

CREATE INDEX IF NOT EXISTS idx_file_versions_session 
ON file_versions (session_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_versions_hash 
ON file_versions (content_hash);

-- 5. Checkpoints Table
CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    kept INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),
    project_references TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session 
ON checkpoints (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_checkpoints_kept 
ON checkpoints (kept, created_at DESC);

-- 6. Checkpoint Junction Tables (Many-to-Many)
CREATE TABLE IF NOT EXISTS checkpoint_file_versions (
    checkpoint_id TEXT NOT NULL,
    file_version_id TEXT NOT NULL,
    PRIMARY KEY (checkpoint_id, file_version_id),
    FOREIGN KEY (checkpoint_id) REFERENCES checkpoints (id) ON DELETE CASCADE,
    FOREIGN KEY (file_version_id) REFERENCES file_versions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cp_fv_version 
ON checkpoint_file_versions (file_version_id);

CREATE TABLE IF NOT EXISTS checkpoint_browser_visits (
    checkpoint_id TEXT NOT NULL,
    browser_visit_id TEXT NOT NULL,
    PRIMARY KEY (checkpoint_id, browser_visit_id),
    FOREIGN KEY (checkpoint_id) REFERENCES checkpoints (id) ON DELETE CASCADE
);
