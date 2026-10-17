ALTER TABLE notifications ADD COLUMN link VARCHAR(255) NULL;
CREATE INDEX idx_notifications_user_read ON notifications (user_id, is_read);