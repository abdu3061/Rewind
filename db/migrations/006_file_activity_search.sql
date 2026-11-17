-- Index only recorded values, including captured file names. Never index JSON property names.
DROP TRIGGER activity_fts_insert;
DROP TRIGGER activity_fts_delete;
DROP TRIGGER activity_fts_update;
DROP TABLE activity_fts;
DROP VIEW activity_search_content;
CREATE VIEW activity_search_content AS
SELECT rowid, CASE type
  WHEN 'foreground' THEN COALESCE(json_extract(payload,'$.application'),'') || ' ' || COALESCE(json_extract(payload,'$.windowTitle'),'')
  WHEN 'file-change' THEN COALESCE(json_extract(payload,'$.displayName'),'')
  WHEN 'browser-visit' THEN COALESCE(json_extract(payload,'$.title'),'') || ' ' || COALESCE(json_extract(payload,'$.url'),'')
  ELSE COALESCE(json_extract(payload,'$.collectorId'),'') || ' ' || COALESCE(json_extract(payload,'$.reason'),'')
END AS text FROM activities;
CREATE VIRTUAL TABLE activity_fts USING fts5(text, content='activity_search_content', content_rowid='rowid');
CREATE TRIGGER activity_fts_insert AFTER INSERT ON activities BEGIN
  INSERT INTO activity_fts(rowid,text) SELECT rowid,text FROM activity_search_content WHERE rowid=new.rowid;
END;
CREATE TRIGGER activity_fts_delete AFTER DELETE ON activities BEGIN
  INSERT INTO activity_fts(activity_fts,rowid,text) VALUES('delete',old.rowid,CASE old.type
    WHEN 'foreground' THEN COALESCE(json_extract(old.payload,'$.application'),'') || ' ' || COALESCE(json_extract(old.payload,'$.windowTitle'),'')
    WHEN 'file-change' THEN COALESCE(json_extract(old.payload,'$.displayName'),'')
    WHEN 'browser-visit' THEN COALESCE(json_extract(old.payload,'$.title'),'') || ' ' || COALESCE(json_extract(old.payload,'$.url'),'')
    ELSE COALESCE(json_extract(old.payload,'$.collectorId'),'') || ' ' || COALESCE(json_extract(old.payload,'$.reason'),'') END);
END;
CREATE TRIGGER activity_fts_update AFTER UPDATE ON activities BEGIN
  INSERT INTO activity_fts(activity_fts,rowid,text) VALUES('delete',old.rowid,CASE old.type
    WHEN 'foreground' THEN COALESCE(json_extract(old.payload,'$.application'),'') || ' ' || COALESCE(json_extract(old.payload,'$.windowTitle'),'')
    WHEN 'file-change' THEN COALESCE(json_extract(old.payload,'$.displayName'),'')
    WHEN 'browser-visit' THEN COALESCE(json_extract(old.payload,'$.title'),'') || ' ' || COALESCE(json_extract(old.payload,'$.url'),'')
    ELSE COALESCE(json_extract(old.payload,'$.collectorId'),'') || ' ' || COALESCE(json_extract(old.payload,'$.reason'),'') END);
  INSERT INTO activity_fts(rowid,text) SELECT rowid,text FROM activity_search_content WHERE rowid=new.rowid;
END;
INSERT INTO activity_fts(activity_fts) VALUES('rebuild');
