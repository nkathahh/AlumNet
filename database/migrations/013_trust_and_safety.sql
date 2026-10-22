-- 013: Trust and safety (Sprint III, Module 2)
-- Members can report profiles and posts, block someone, and introduce
-- themselves when asking for mentorship. Posts carry automatic scam checks
-- so the alumni office sees risky content first.

CREATE TABLE IF NOT EXISTS reports (
  report_id INT AUTO_INCREMENT PRIMARY KEY,
  reporter_id INT NOT NULL,
  target_type ENUM('user','opportunity','event') NOT NULL,
  target_id INT NOT NULL,
  reason ENUM('fake_profile','asked_for_money','harassment','spam','misleading','other') NOT NULL,
  details VARCHAR(500) NULL,
  status ENUM('open','actioned','dismissed') NOT NULL DEFAULT 'open',
  resolved_by INT NULL,
  resolved_at DATETIME NULL,
  resolution_note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reports_target (target_type, target_id, status),
  KEY idx_reports_status (status),
  CONSTRAINT fk_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_reports_resolver FOREIGN KEY (resolved_by) REFERENCES users(user_id) ON DELETE SET NULL
);

-- A member can stop another member from contacting them
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id INT NOT NULL,
  blocked_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT fk_blocks_blocker FOREIGN KEY (blocker_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_blocks_blocked FOREIGN KEY (blocked_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Automatic scam checks, stored with the post so admins see the reasons
ALTER TABLE career_opportunities
  ADD COLUMN risk_level ENUM('low','medium','high') NULL,
  ADD COLUMN risk_flags TEXT NULL;

ALTER TABLE events
  ADD COLUMN risk_level ENUM('low','medium','high') NULL,
  ADD COLUMN risk_flags TEXT NULL;

-- Mentees say why they are reaching out, so mentors can decide well
ALTER TABLE mentorship_requests
  ADD COLUMN message VARCHAR(500) NULL,
  ADD COLUMN responded_at DATETIME NULL;
