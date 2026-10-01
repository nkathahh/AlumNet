CREATE TABLE users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  status ENUM('active','suspended') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE mentees (
  user_id INT PRIMARY KEY,
  graduation_year YEAR NULL,
  CONSTRAINT fk_mentees_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE mentors (
  user_id INT PRIMARY KEY,
  years_of_experience TINYINT UNSIGNED NULL,
  CONSTRAINT fk_mentors_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE admins (
  user_id INT PRIMARY KEY,
  admin_level VARCHAR(30) NOT NULL DEFAULT 'standard',
  CONSTRAINT fk_admins_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE profiles (
  profile_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  skills TEXT NULL,
  experience TEXT NULL,
  career_interests TEXT NULL,
  industry VARCHAR(100) NULL,
  CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE KEY uq_profiles_user (user_id)
);

CREATE TABLE mentorship_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  mentee_id INT NOT NULL,
  mentor_id INT NOT NULL,
  status ENUM('pending','accepted','declined') NOT NULL DEFAULT 'pending',
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_req_mentee FOREIGN KEY (mentee_id) REFERENCES mentees(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_req_mentor FOREIGN KEY (mentor_id) REFERENCES mentors(user_id) ON DELETE CASCADE
);

CREATE TABLE bookmarks (
  mentee_id INT NOT NULL,
  mentor_id INT NOT NULL,
  bookmarked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mentee_id, mentor_id),
  CONSTRAINT fk_bm_mentee FOREIGN KEY (mentee_id) REFERENCES mentees(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_bm_mentor FOREIGN KEY (mentor_id) REFERENCES mentors(user_id) ON DELETE CASCADE
);

CREATE TABLE career_opportunities (
  opportunity_id INT AUTO_INCREMENT PRIMARY KEY,
  posted_by INT NOT NULL,
  title VARCHAR(150) NOT NULL,
  description TEXT NULL,
  industry VARCHAR(100) NULL,
  approval_status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  CONSTRAINT fk_opp_mentor FOREIGN KEY (posted_by) REFERENCES mentors(user_id) ON DELETE CASCADE
);

CREATE TABLE events (
  event_id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(150) NOT NULL,
  description TEXT NULL,
  event_date DATETIME NOT NULL
);

CREATE TABLE event_participation (
  event_id INT NOT NULL,
  user_id INT NOT NULL,
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT fk_ep_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
  CONSTRAINT fk_ep_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE notifications (
  notification_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  message VARCHAR(255) NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE admin_activity_logs (
  log_id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NOT NULL,
  action_type VARCHAR(50) NOT NULL,
  target_entity VARCHAR(50) NOT NULL,
  target_entity_id INT NOT NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_log_admin FOREIGN KEY (admin_id) REFERENCES admins(user_id) ON DELETE CASCADE
);

CREATE TABLE content_approvals (
  approval_id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NOT NULL,
  opportunity_id INT NOT NULL,
  status ENUM('approved','rejected') NOT NULL,
  review_notes VARCHAR(255) NULL,
  reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_appr_admin FOREIGN KEY (admin_id) REFERENCES admins(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_appr_opp FOREIGN KEY (opportunity_id) REFERENCES career_opportunities(opportunity_id) ON DELETE CASCADE
);