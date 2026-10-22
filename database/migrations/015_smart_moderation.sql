-- 015: Smart moderation
-- Posts are sorted into three lanes: fast (published straight away for
-- trusted posters), queue (an admin decides) and hold (never published
-- automatically). The system learns from admin decisions through lists of
-- known employer websites and blocked websites or emails. Every automatic
-- step is logged with "Automatic" as the actor.

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(50) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
-- The fast lane starts switched off; the alumni office turns it on
INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('auto_approve', 'off');

-- Websites of employers whose posts an admin has approved
CREATE TABLE IF NOT EXISTS trusted_domains (
  domain VARCHAR(190) PRIMARY KEY,
  approvals INT NOT NULL DEFAULT 1,
  first_approved_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_trusted_admin FOREIGN KEY (first_approved_by) REFERENCES users(user_id) ON DELETE SET NULL
);
-- Kenya Airways and the usual meeting tools are known from the start
INSERT IGNORE INTO trusted_domains (domain, approvals) VALUES
  ('kenya-airways.com', 1), ('zoom.us', 1), ('teams.microsoft.com', 1), ('meet.google.com', 1);

-- Websites, emails and exact links (for shortened or shared sites) from posts rejected as scams
CREATE TABLE IF NOT EXISTS blocked_indicators (
  indicator_id INT AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('domain','email','link') NOT NULL,
  value VARCHAR(190) NOT NULL,
  reason VARCHAR(255) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_blocked (kind, value),
  CONSTRAINT fk_blocked_admin FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);

ALTER TABLE career_opportunities
  MODIFY approval_status ENUM('pending','approved','rejected','changes_requested') NOT NULL DEFAULT 'pending',
  ADD COLUMN moderation_lane ENUM('fast','queue','hold') NULL,
  ADD COLUMN lane_reasons TEXT NULL,
  ADD COLUMN auto_approved TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN rejection_reason ENUM('asks_for_payment','misleading','duplicate','missing_details','not_relevant','broken_link') NULL,
  ADD COLUMN review_note VARCHAR(255) NULL,
  ADD COLUMN reviewed_at DATETIME NULL,
  ADD COLUMN submitted_at DATETIME NULL;
UPDATE career_opportunities SET submitted_at = created_at WHERE submitted_at IS NULL;

ALTER TABLE events
  MODIFY status ENUM('pending','approved','rejected','changes_requested') NOT NULL DEFAULT 'approved',
  ADD COLUMN moderation_lane ENUM('fast','queue','hold') NULL,
  ADD COLUMN lane_reasons TEXT NULL,
  ADD COLUMN auto_approved TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN rejection_reason ENUM('asks_for_payment','misleading','duplicate','missing_details','not_relevant','broken_link') NULL,
  ADD COLUMN review_note VARCHAR(255) NULL,
  ADD COLUMN reviewed_at DATETIME NULL,
  ADD COLUMN submitted_at DATETIME NULL,
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE events SET submitted_at = created_at WHERE submitted_at IS NULL;

-- Automatic decisions are logged without an admin
ALTER TABLE admin_activity_logs MODIFY admin_id INT NULL;
