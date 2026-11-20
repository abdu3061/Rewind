-- Derived bounded text stays in the same verified cipher database as its original.
CREATE TABLE file_text (
  version_id TEXT NOT NULL UNIQUE REFERENCES file_versions(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  revision INTEGER NOT NULL CHECK(revision=1),
  format TEXT NOT NULL CHECK(format IN ('utf8','docx','pdf')),
  state TEXT NOT NULL CHECK(state IN ('available','unavailable')),
  text TEXT,
  text_hash TEXT CHECK(text_hash IS NULL OR length(text_hash)=64),
  truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
  pages_read INTEGER,
  total_pages INTEGER,
  issue TEXT CHECK(issue IS NULL OR issue IN ('unsupported','malformed','encrypted','limit','timeout','unavailable')),
  indexed_at TEXT NOT NULL,
  CHECK((state='available' AND text IS NOT NULL AND text_hash IS NOT NULL AND issue IS NULL AND length(CAST(text AS BLOB))<=65536)
     OR (state='unavailable' AND text IS NULL AND text_hash IS NULL AND issue IS NOT NULL AND truncated=0 AND pages_read IS NULL AND total_pages IS NULL)),
  CHECK(state='unavailable' OR (format='pdf' AND pages_read IS NOT NULL AND total_pages IS NOT NULL AND pages_read BETWEEN 1 AND 50 AND total_pages>=pages_read AND (pages_read=total_pages OR truncated=1))
     OR (format!='pdf' AND pages_read IS NULL AND total_pages IS NULL))
);
CREATE TRIGGER file_text_source_insert BEFORE INSERT ON file_text
WHEN NOT EXISTS (SELECT 1 FROM file_versions v WHERE v.id=new.version_id AND v.content_hash=new.content_hash AND v.blob_hash=new.content_hash)
BEGIN SELECT RAISE(ABORT,'FILE_TEXT_SOURCE_MISMATCH'); END;
CREATE TRIGGER file_text_source_update BEFORE UPDATE ON file_text
WHEN old.state='available' OR old.version_id!=new.version_id OR old.content_hash!=new.content_hash
  OR NOT EXISTS (SELECT 1 FROM file_versions v WHERE v.id=new.version_id AND v.content_hash=new.content_hash AND v.blob_hash=new.content_hash)
BEGIN SELECT RAISE(ABORT,'FILE_TEXT_IMMUTABLE'); END;
CREATE VIRTUAL TABLE file_text_fts USING fts5(text,content='file_text',content_rowid='rowid');
CREATE TRIGGER file_text_fts_insert AFTER INSERT ON file_text BEGIN
  INSERT INTO file_text_fts(rowid,text) VALUES(new.rowid,new.text);
END;
CREATE TRIGGER file_text_fts_delete AFTER DELETE ON file_text BEGIN
  INSERT INTO file_text_fts(file_text_fts,rowid,text) VALUES('delete',old.rowid,old.text);
END;
CREATE TRIGGER file_text_fts_update AFTER UPDATE ON file_text BEGIN
  INSERT INTO file_text_fts(file_text_fts,rowid,text) VALUES('delete',old.rowid,old.text);
  INSERT INTO file_text_fts(rowid,text) VALUES(new.rowid,new.text);
END;
