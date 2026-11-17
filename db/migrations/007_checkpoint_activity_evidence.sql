CREATE TABLE checkpoint_activities (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  PRIMARY KEY(checkpoint_id, activity_id)
);
CREATE INDEX idx_checkpoint_activity ON checkpoint_activities(activity_id);
INSERT INTO checkpoint_activities(checkpoint_id,activity_id)
  SELECT checkpoint_id,browser_visit_id FROM checkpoint_browser_visits;
CREATE TRIGGER checkpoint_activity_membership BEFORE INSERT ON checkpoint_activities
WHEN NOT EXISTS (
  SELECT 1 FROM activities a JOIN checkpoints c ON c.id=NEW.checkpoint_id
  WHERE a.id=NEW.activity_id AND a.session_id=c.session_id
)
BEGIN SELECT RAISE(ABORT, 'CHECKPOINT_ACTIVITY_MEMBERSHIP'); END;
