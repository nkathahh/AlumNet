-- 017: Requests that wait too long expire
-- A request with no reply after 14 days expires, so mentees are not left
-- waiting on a mentor who is busy, full or no longer active.
ALTER TABLE mentorship_requests
  MODIFY status ENUM('pending','accepted','declined','ended','expired') NOT NULL DEFAULT 'pending';
