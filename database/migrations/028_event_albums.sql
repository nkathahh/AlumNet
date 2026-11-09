-- 028: Event albums and cover photos
-- album_url: a Google Photos album with every photo from the event. AlumNet
-- keeps only the highlights; the link opens the full album on Google Photos.
-- cover_image_id: the photo the organiser chose to show on the event card.
-- Without one, the first photo added is used.

ALTER TABLE events
  ADD COLUMN album_url VARCHAR(300) NULL,
  ADD COLUMN cover_image_id INT NULL,
  ADD CONSTRAINT fk_events_cover FOREIGN KEY (cover_image_id) REFERENCES images(image_id) ON DELETE SET NULL;
