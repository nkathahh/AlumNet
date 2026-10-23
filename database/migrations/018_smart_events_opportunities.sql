-- 018: Smart events and opportunities (Sprint III, Module 4)
-- Opportunities list the skills they need, so staff can see how close they
-- are. Events say what they are about and who they are for. Members get a
-- few well-matched alerts instead of a stream of everything.

ALTER TABLE career_opportunities
  ADD COLUMN required_skills VARCHAR(500) NULL AFTER description;

ALTER TABLE events
  ADD COLUMN topics VARCHAR(255) NULL AFTER description,
  ADD COLUMN audience_departments VARCHAR(500) NULL AFTER topics;

-- Members choose which alerts they want; both start on
ALTER TABLE users
  ADD COLUMN alert_opportunities TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN alert_events TINYINT(1) NOT NULL DEFAULT 1;

-- Which alerts were sent, so nobody gets more than a few a week or the same one twice
CREATE TABLE IF NOT EXISTS alerts_sent (
  user_id INT NOT NULL,
  item_type ENUM('opportunity','event') NOT NULL,
  item_id INT NOT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, item_type, item_id),
  KEY idx_alerts_user_time (user_id, sent_at),
  CONSTRAINT fk_alerts_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Cached vectors for opportunities and events, like profile_embeddings
CREATE TABLE IF NOT EXISTS item_embeddings (
  item_key VARCHAR(40) PRIMARY KEY,
  text_hash CHAR(64) NOT NULL,
  vector MEDIUMTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
