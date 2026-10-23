-- 022: Mentorship outcomes (Module 5)
-- Until now the system knew a mentorship started, not whether it helped.
-- A pair agrees a few goals, either of them logs meetings, and when it ends
-- both say privately how it went. Ratings are only shown to the alumni office,
-- and only added up, so people can be honest.

CREATE TABLE IF NOT EXISTS mentorship_goals (
  goal_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  text VARCHAR(200) NOT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  done_at DATETIME NULL,
  INDEX idx_goals_request (request_id),
  CONSTRAINT fk_goal_request FOREIGN KEY (request_id) REFERENCES mentorship_requests(request_id) ON DELETE CASCADE,
  CONSTRAINT fk_goal_user FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mentorship_meetings (
  meeting_id INT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  met_on DATE NOT NULL,
  mode ENUM('in_person','virtual','phone') NOT NULL,
  minutes SMALLINT NOT NULL,
  note VARCHAR(500) NULL,
  logged_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_meetings_request (request_id),
  CONSTRAINT fk_meeting_request FOREIGN KEY (request_id) REFERENCES mentorship_requests(request_id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_user FOREIGN KEY (logged_by) REFERENCES users(user_id) ON DELETE SET NULL
);

-- One answer per person per mentorship, given after it ends
CREATE TABLE IF NOT EXISTS mentorship_feedback (
  request_id INT NOT NULL,
  user_id INT NOT NULL,
  side ENUM('mentee','mentor') NOT NULL,
  met TINYINT(1) NOT NULL,
  helpful TINYINT NULL,           -- 1 (not at all) to 5 (very), only if they met
  goals_progress ENUM('none','some','most','all') NULL,
  felt_safe TINYINT(1) NOT NULL DEFAULT 1,
  comment VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, user_id),
  CONSTRAINT fk_fb_request FOREIGN KEY (request_id) REFERENCES mentorship_requests(request_id) ON DELETE CASCADE,
  CONSTRAINT fk_fb_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
