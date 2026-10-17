ALTER TABLE career_opportunities
  ADD COLUMN company VARCHAR(150) NULL,
  ADD COLUMN opportunity_type ENUM('full_time', 'part_time', 'contract', 'consultancy', 'internal_transfer', 'volunteer') NOT NULL DEFAULT 'full_time',
  ADD COLUMN location VARCHAR(150) NULL,
  ADD COLUMN apply_link VARCHAR(255) NULL,
  ADD COLUMN closing_date DATE NULL,
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;