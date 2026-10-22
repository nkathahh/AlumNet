-- 012: Location is optional at sign-up. People add their city during the
-- welcome setup, so these columns must not block account creation.
ALTER TABLE users
  MODIFY country VARCHAR(100) NULL DEFAULT 'Kenya',
  MODIFY city VARCHAR(100) NULL;
