-- 023: Which version of the privacy notice each member accepted
-- Until now only the date of acceptance was kept, so when the notice changed
-- nobody could tell who had agreed to which text. Members who accepted an
-- older version (or before versions were recorded) are asked to read and
-- accept the current notice before carrying on. Every acceptance is kept as
-- evidence of consent.

ALTER TABLE users ADD COLUMN privacy_version VARCHAR(20) NULL AFTER privacy_accepted_at;
ALTER TABLE signup_requests ADD COLUMN privacy_version VARCHAR(20) NULL AFTER privacy_accepted_at;

CREATE TABLE IF NOT EXISTS privacy_acceptances (
  user_id INT NOT NULL,
  version VARCHAR(20) NOT NULL,
  accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, version),
  CONSTRAINT fk_privacy_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
