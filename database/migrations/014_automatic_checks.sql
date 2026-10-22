-- 014: Automatic checks on messages and profiles
-- The scam check now also reads mentorship request messages and profile
-- text. A high-risk result files a report from "Automatic check", so it
-- reaches the alumni office through the same Reports queue as members' reports.

ALTER TABLE reports
  MODIFY reporter_id INT NULL,
  ADD COLUMN source ENUM('member','automatic') NOT NULL DEFAULT 'member' AFTER reporter_id;

ALTER TABLE mentorship_requests
  ADD COLUMN risk_flags TEXT NULL;
