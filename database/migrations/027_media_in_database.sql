-- 027: Image files kept in the database
-- Free hosts such as Hugging Face Spaces wipe their disk on every restart, so
-- with MEDIA_DRIVER=db the redrawn WebP files are stored here instead. Each
-- row is one file, named <key>-<size>.webp, as on disk or in a bucket.

CREATE TABLE IF NOT EXISTS media_files (
  name VARCHAR(64) NOT NULL PRIMARY KEY,
  data MEDIUMBLOB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
