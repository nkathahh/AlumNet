-- 019: Editing live posts and events (Sprint III, Module 4)
-- Plans change: a venue moves, a closing date is extended, a role is filled.
-- Posters can now edit what is already live. Safe edits stay live; edits that
-- change a link or trip the scam checks go back to the alumni office first,
-- so an approved post cannot be swapped for a scam afterwards.

ALTER TABLE events
  MODIFY status ENUM('pending','approved','rejected','changes_requested','cancelled') NOT NULL DEFAULT 'approved',
  ADD COLUMN edited_at DATETIME NULL,
  -- What changed for people already registered, sent to them once the edit is live
  ADD COLUMN change_summary VARCHAR(500) NULL,
  ADD COLUMN cancel_reason VARCHAR(255) NULL;

ALTER TABLE career_opportunities
  ADD COLUMN edited_at DATETIME NULL,
  -- Set when the poster closes the post early (the role was filled)
  ADD COLUMN closed_at DATETIME NULL;
