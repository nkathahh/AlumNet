-- 011: Identity redesign (Sprint III, Module 1)
-- Sign-up is verified by proving ownership of the email HR holds, roles come
-- from the HR record, sessions can be revoked, and AlumNet stops storing
-- personal data it does not need.

-- HR record: the email used to verify former staff, and whether a person
-- may join the alumni network at all (for example not after dismissal)
ALTER TABLE staff_directory
  ADD COLUMN personal_email VARCHAR(190) NULL AFTER kq_email,
  ADD COLUMN alumni_eligible TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Users: verification, session control and privacy consent
ALTER TABLE users
  ADD COLUMN email_verified_at DATETIME NULL,
  ADD COLUMN session_version INT NOT NULL DEFAULT 0,
  ADD COLUMN last_login_at DATETIME NULL,
  ADD COLUMN privacy_accepted_at DATETIME NULL,
  ADD COLUMN onboarded_at DATETIME NULL,
  MODIFY status ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active';

-- Existing accounts were created before this change: treat them as verified
-- and onboarded so nobody is locked out
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
UPDATE users SET onboarded_at = created_at WHERE onboarded_at IS NULL;

-- Usernames are removed: email is the single sign-in identifier
-- Dropping a column also drops any index on it, whatever the index is called
ALTER TABLE users DROP COLUMN username;

-- Data minimisation: national ID and phone numbers stay in the HR record
-- only. AlumNet never needs its own copy after verification.
ALTER TABLE users DROP COLUMN id_number, DROP COLUMN mobile_number;

-- Each sign-up attempt. Tokens are stored only as SHA-256 hashes.
CREATE TABLE signup_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  staff_number VARCHAR(20) NOT NULL,
  email VARCHAR(190) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  hr_match TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('awaiting_email','pending_review','approved','rejected','completed','expired') NOT NULL DEFAULT 'awaiting_email',
  full_name VARCHAR(150) NULL,
  phone VARCHAR(30) NULL,
  password_hash VARCHAR(255) NULL,
  risk_level ENUM('low','medium','high') NULL,
  risk_signals TEXT NULL,
  ip_address VARCHAR(45) NULL,
  privacy_accepted_at DATETIME NULL,
  email_verified_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  reviewed_by INT NULL,
  reviewed_at DATETIME NULL,
  review_note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_signup_token (token_hash),
  KEY idx_signup_staff (staff_number),
  KEY idx_signup_status (status),
  CONSTRAINT fk_signup_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(user_id) ON DELETE SET NULL
);

-- One-time backup codes for two-factor authentication (hashed)
CREATE TABLE two_factor_backup_codes (
  code_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_backup_user (user_id),
  CONSTRAINT fk_backup_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Readable activity log: the name of what was acted on, saved at the time
ALTER TABLE admin_activity_logs
  ADD COLUMN target_label VARCHAR(255) NULL AFTER target_entity_id;

-- ---------------------------------------------------------------------
-- Synthetic demo data alignment (no real people)
-- ---------------------------------------------------------------------
-- Demo mentor accounts were created before roles came from HR. Record those
-- people as former staff, with their account email as the personal email HR
-- holds, so their existing accounts keep the mentor role.
UPDATE staff_directory sd
JOIN users u ON u.staff_number = sd.staff_number
JOIN mentors m ON m.user_id = u.user_id
SET sd.employment_status = 'former', sd.personal_email = u.email;

-- Other former staff get a personal email on the reserved example.com
-- domain, which can never deliver mail to a real person
UPDATE staff_directory
SET personal_email = CONCAT(LOWER(REPLACE(full_name, ' ', '.')), '@example.com')
WHERE employment_status = 'former' AND personal_email IS NULL;

-- One former staff member marked as not eligible, to demonstrate the rule
UPDATE staff_directory
SET alumni_eligible = 0
WHERE staff_number = 'KQ60821'
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.staff_number = 'KQ60821');

-- One account per staff member (several NULLs are still allowed, for admins)
ALTER TABLE users ADD UNIQUE KEY uq_users_staff_number (staff_number);
