-- 025: Photos and images
-- Profile photos, event banners, photos from past events, company logos on
-- opportunities and screenshots attached to reports. The files themselves
-- live in storage (a folder on the server, or an S3-compatible bucket such
-- as Cloudflare R2); this table records who uploaded each one, what it
-- belongs to and whether others may see it yet.
-- Images posted by mentors are checked by an admin before anyone else sees
-- them, like posts. Profile photos go live straight away and can be reported.
-- Report screenshots are only ever shown to admins and are deleted when the
-- report is closed.

CREATE TABLE IF NOT EXISTS images (
  image_id INT AUTO_INCREMENT PRIMARY KEY,
  storage_key CHAR(32) NOT NULL,
  kind ENUM('avatar','event_banner','event_photo','logo','report_evidence') NOT NULL,
  uploaded_by INT NULL,
  event_id INT NULL,
  opportunity_id INT NULL,
  report_id INT NULL,
  status ENUM('live','pending') NOT NULL DEFAULT 'pending',
  caption VARCHAR(150) NULL,
  width SMALLINT UNSIGNED NULL,
  height SMALLINT UNSIGNED NULL,
  bytes INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by INT NULL,
  reviewed_at DATETIME NULL,
  UNIQUE KEY uq_images_key (storage_key),
  INDEX idx_images_kind_status (kind, status, created_at),
  INDEX idx_images_event (event_id),
  INDEX idx_images_opportunity (opportunity_id),
  INDEX idx_images_report (report_id),
  INDEX idx_images_uploader (uploaded_by),
  -- When the thing an image belongs to is deleted, the link is cleared and
  -- the clean-up job removes the image and its files
  CONSTRAINT fk_images_uploader FOREIGN KEY (uploaded_by) REFERENCES users(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_images_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE SET NULL,
  CONSTRAINT fk_images_opportunity FOREIGN KEY (opportunity_id) REFERENCES career_opportunities(opportunity_id) ON DELETE SET NULL,
  CONSTRAINT fk_images_report FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE SET NULL,
  CONSTRAINT fk_images_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(user_id) ON DELETE SET NULL
);

-- The image currently shown, once it is live
ALTER TABLE users ADD COLUMN avatar_key CHAR(32) NULL;
ALTER TABLE events ADD COLUMN banner_key CHAR(32) NULL;
ALTER TABLE career_opportunities ADD COLUMN logo_key CHAR(32) NULL;
