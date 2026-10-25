-- 024: Account recovery and admin management
-- A member who loses both their phone and their backup codes can have
-- two-factor reset by an admin, after checking who they are against HR. They
-- must set it up again before using AlumNet.
-- Admins can be added and removed in the app. With two or more admins, a
-- different admin approves each change (the same "four eyes" rule as HR imports).

ALTER TABLE users ADD COLUMN totp_setup_required TINYINT(1) NOT NULL DEFAULT 0 AFTER totp_enabled;

ALTER TABLE admins
  ADD COLUMN added_by INT NULL,
  ADD COLUMN added_at DATETIME NULL;

CREATE TABLE IF NOT EXISTS admin_role_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  action ENUM('add','remove') NOT NULL,
  target_user_id INT NOT NULL,
  requested_by INT NOT NULL,
  note VARCHAR(255) NULL,
  status ENUM('waiting','applied','rejected','cancelled') NOT NULL DEFAULT 'waiting',
  decided_by INT NULL,
  decided_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_admin_req_status (status, created_at),
  CONSTRAINT fk_admin_req_target FOREIGN KEY (target_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_admin_req_by FOREIGN KEY (requested_by) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_admin_req_decided FOREIGN KEY (decided_by) REFERENCES users(user_id) ON DELETE SET NULL
);
