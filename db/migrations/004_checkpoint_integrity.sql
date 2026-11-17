-- Refuse dangling historical visit membership instead of silently discarding it.
CREATE TABLE checkpoint_browser_visits_verified (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  browser_visit_id TEXT NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  PRIMARY KEY(checkpoint_id, browser_visit_id)
);
INSERT INTO checkpoint_browser_visits_verified SELECT * FROM checkpoint_browser_visits;
DROP TABLE checkpoint_browser_visits;
ALTER TABLE checkpoint_browser_visits_verified RENAME TO checkpoint_browser_visits;

CREATE TABLE checkpoint_membership_guard (valid INTEGER NOT NULL CHECK(valid=1));
INSERT INTO checkpoint_membership_guard SELECT CASE WHEN EXISTS (
  SELECT 1 FROM checkpoint_browser_visits b
  JOIN activities a ON a.id=b.browser_visit_id JOIN checkpoints c ON c.id=b.checkpoint_id
  WHERE a.type!='browser-visit' OR a.session_id!=c.session_id
) OR EXISTS (
  SELECT 1 FROM checkpoint_file_versions b
  JOIN file_versions v ON v.id=b.file_version_id JOIN checkpoints c ON c.id=b.checkpoint_id
  WHERE v.session_id!=c.session_id
) THEN 0 ELSE 1 END;
DROP TABLE checkpoint_membership_guard;

CREATE TRIGGER checkpoint_visit_membership BEFORE INSERT ON checkpoint_browser_visits
WHEN NOT EXISTS (
  SELECT 1 FROM activities a JOIN checkpoints c ON c.id=NEW.checkpoint_id
  WHERE a.id=NEW.browser_visit_id AND a.type='browser-visit' AND a.session_id=c.session_id
)
BEGIN SELECT RAISE(ABORT, 'CHECKPOINT_VISIT_MEMBERSHIP'); END;
CREATE TRIGGER checkpoint_version_membership BEFORE INSERT ON checkpoint_file_versions
WHEN NOT EXISTS (
  SELECT 1 FROM file_versions v JOIN checkpoints c ON c.id=NEW.checkpoint_id
  WHERE v.id=NEW.file_version_id AND v.session_id=c.session_id
)
BEGIN SELECT RAISE(ABORT, 'CHECKPOINT_VERSION_MEMBERSHIP'); END;
