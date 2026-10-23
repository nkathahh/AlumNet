-- 021: Small fixes before Module 5
-- Event reminders are sent once, the day before
ALTER TABLE events ADD COLUMN reminder_sent_at DATETIME NULL;

-- The original event_participation table was replaced by event_registrations
-- (migration 006) and is not used anywhere
DROP TABLE IF EXISTS event_participation;

-- bookmarks (from migration 001) is now used: mentees save mentors to a
-- shortlist before choosing whom to ask, since only 5 requests can wait at once
