-- Secure recording metadata only. No captured document bytes or browser collection.
CREATE TABLE runtime_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL
);
CREATE INDEX idx_activities_cursor ON activities (session_id, occurred_at DESC, id DESC);
CREATE INDEX idx_sessions_cursor ON sessions (started_at DESC, id DESC);
CREATE VIRTUAL TABLE activity_fts USING fts5(payload, content='activities', content_rowid='rowid');
CREATE TRIGGER activity_fts_insert AFTER INSERT ON activities BEGIN
    INSERT INTO activity_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
CREATE TRIGGER activity_fts_delete AFTER DELETE ON activities BEGIN
    INSERT INTO activity_fts(activity_fts, rowid, payload) VALUES ('delete', old.rowid, old.payload);
END;
CREATE TRIGGER activity_fts_update AFTER UPDATE ON activities BEGIN
    INSERT INTO activity_fts(activity_fts, rowid, payload) VALUES ('delete', old.rowid, old.payload);
    INSERT INTO activity_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
INSERT INTO activity_fts(activity_fts) VALUES ('rebuild');
