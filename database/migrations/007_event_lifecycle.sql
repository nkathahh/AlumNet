ALTER TABLE events
  ADD COLUMN location VARCHAR(255) NULL,
  ADD COLUMN mode ENUM('in_person', 'virtual') NOT NULL DEFAULT 'in_person',
  ADD COLUMN capacity INT NULL,
  ADD COLUMN created_by INT NULL,
  ADD COLUMN status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'approved',
  ADD CONSTRAINT fk_events_created_by FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL;