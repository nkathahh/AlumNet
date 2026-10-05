ALTER TABLE mentorship_requests
  MODIFY status ENUM('pending','accepted','declined','ended') NOT NULL DEFAULT 'pending';

ALTER TABLE mentorship_requests
  ADD COLUMN ended_by INT NULL AFTER status,
  ADD COLUMN ended_at DATETIME NULL AFTER ended_by,
  ADD CONSTRAINT fk_mr_ended_by FOREIGN KEY (ended_by) REFERENCES users(user_id) ON DELETE SET NULL;