-- 016: Discovery (Sprint III, Module 3)
-- Mentors say whether they are taking mentees and how many, so nobody is
-- flooded and mentees only ask people who have room. Gender is optional and
-- only used in filters when the person agrees. Profile embeddings are cached
-- so the matching service does not re-read every profile on every request.

ALTER TABLE mentors
  ADD COLUMN accepting_mentees TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN max_mentees TINYINT UNSIGNED NOT NULL DEFAULT 3,
  ADD COLUMN meeting_mode ENUM('in_person','virtual','either') NOT NULL DEFAULT 'either',
  ADD COLUMN availability_note VARCHAR(150) NULL;

ALTER TABLE profiles
  ADD COLUMN gender ENUM('female','male','another') NULL,
  ADD COLUMN gender_in_search TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS profile_embeddings (
  user_id INT NOT NULL,
  kind VARCHAR(20) NOT NULL,
  text_hash CHAR(64) NOT NULL,
  vector MEDIUMTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, kind),
  CONSTRAINT fk_embeddings_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
