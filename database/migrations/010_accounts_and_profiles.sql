-- 010: Account security and professional profiles
-- Adds usernames, Google sign-in linking, two-factor authentication,
-- password reset tokens and richer profile fields.

ALTER TABLE users
  ADD COLUMN username VARCHAR(30) NULL AFTER email,
  ADD COLUMN google_id VARCHAR(64) NULL,
  ADD COLUMN totp_secret VARCHAR(64) NULL,
  ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN password_changed_at DATETIME NULL,
  ADD UNIQUE KEY uq_users_username (username),
  ADD UNIQUE KEY uq_users_google_id (google_id);

-- One row per reset request. Only a SHA-256 hash of the token is stored,
-- so a database leak does not expose usable reset links.
CREATE TABLE password_resets (
  reset_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_password_resets_token (token_hash),
  KEY idx_password_resets_user (user_id),
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

ALTER TABLE profiles
  ADD COLUMN headline VARCHAR(120) NULL,
  ADD COLUMN bio TEXT NULL,
  ADD COLUMN linkedin_url VARCHAR(255) NULL;
