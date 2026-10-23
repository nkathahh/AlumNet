-- 020: Hardening after the Module 4 review
-- Two-factor secrets are now stored encrypted (AES-256-GCM), which is longer
-- than the plain secret. The server encrypts existing secrets at start-up.
ALTER TABLE users MODIFY totp_secret VARCHAR(255) NULL;

-- Rate limits are counted here instead of in server memory, so a restart
-- does not give a password guesser a fresh start
CREATE TABLE IF NOT EXISTS rate_limits (
  rl_key VARCHAR(190) NOT NULL PRIMARY KEY,
  hits INT NOT NULL DEFAULT 0,
  reset_at DATETIME NOT NULL,
  INDEX idx_rate_limits_reset (reset_at)
);

-- HR imports change who can sign in and who becomes a mentor. When there is
-- more than one admin, a second admin must approve an import before it applies.
CREATE TABLE IF NOT EXISTS hr_import_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  requested_by INT NOT NULL,
  rows_json MEDIUMTEXT NOT NULL,
  summary VARCHAR(255) NOT NULL,
  status ENUM('waiting','applied','rejected') NOT NULL DEFAULT 'waiting',
  decided_by INT NULL,
  decided_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hr_req_by FOREIGN KEY (requested_by) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_hr_req_decided FOREIGN KEY (decided_by) REFERENCES users(user_id) ON DELETE SET NULL
);

-- A waiting list for full events: when someone cancels, the next person in
-- line gets the place automatically and is told
CREATE TABLE IF NOT EXISTS event_waitlist (
  event_id INT NOT NULL,
  user_id INT NOT NULL,
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id, user_id),
  INDEX idx_waitlist_order (event_id, joined_at),
  CONSTRAINT fk_waitlist_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
  CONSTRAINT fk_waitlist_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- How many posts one account can make in 24 hours before the rest are held
-- for an admin (the alumni office can change it from 2 to 20 in Moderation)
INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('burst_per_day', '5');
