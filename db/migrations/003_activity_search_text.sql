-- Index observed values rather than JSON property names. Existing activity rows are preserved.
DROP TRIGGER activity_fts_insert;
DROP TRIGGER activity_fts_delete;
DROP TRIGGER activity_fts_update;
DROP TABLE activity_fts;
CREATE VIEW activity_search_content AS
SELECT rowid,
    CASE WHEN type = 'foreground' THEN
        COALESCE(json_extract(payload, '$.application'), '') || ' ' ||
        COALESCE(json_extract(payload, '$.windowTitle'), '')
    ELSE
        COALESCE(json_extract(payload, '$.collectorId'), '') || ' ' ||
        COALESCE(json_extract(payload, '$.reason'), '')
    END AS text
FROM activities;
CREATE VIRTUAL TABLE activity_fts USING fts5(text, content='activity_search_content', content_rowid='rowid');
CREATE TRIGGER activity_fts_insert AFTER INSERT ON activities BEGIN
    INSERT INTO activity_fts(rowid, text) SELECT rowid, text FROM activity_search_content WHERE rowid = new.rowid;
END;
CREATE TRIGGER activity_fts_delete AFTER DELETE ON activities BEGIN
    INSERT INTO activity_fts(activity_fts, rowid, text) VALUES ('delete', old.rowid,
        CASE WHEN old.type = 'foreground' THEN
            COALESCE(json_extract(old.payload, '$.application'), '') || ' ' ||
            COALESCE(json_extract(old.payload, '$.windowTitle'), '')
        ELSE
            COALESCE(json_extract(old.payload, '$.collectorId'), '') || ' ' ||
            COALESCE(json_extract(old.payload, '$.reason'), '')
        END);
END;
CREATE TRIGGER activity_fts_update AFTER UPDATE ON activities BEGIN
    INSERT INTO activity_fts(activity_fts, rowid, text) VALUES ('delete', old.rowid,
        CASE WHEN old.type = 'foreground' THEN
            COALESCE(json_extract(old.payload, '$.application'), '') || ' ' ||
            COALESCE(json_extract(old.payload, '$.windowTitle'), '')
        ELSE
            COALESCE(json_extract(old.payload, '$.collectorId'), '') || ' ' ||
            COALESCE(json_extract(old.payload, '$.reason'), '')
        END);
    INSERT INTO activity_fts(rowid, text) SELECT rowid, text FROM activity_search_content WHERE rowid = new.rowid;
END;
INSERT INTO activity_fts(activity_fts) VALUES ('rebuild');
