ALTER TABLE users
  ADD COLUMN id_number    VARCHAR(20)  NULL AFTER email,
  ADD COLUMN staff_number VARCHAR(20)  NULL AFTER id_number,
  ADD COLUMN mobile_number VARCHAR(20) NULL AFTER staff_number,
  ADD COLUMN country      VARCHAR(100) NULL AFTER mobile_number,
  ADD COLUMN city         VARCHAR(100) NULL AFTER country;

ALTER TABLE users
  ADD UNIQUE KEY uq_users_id_number (id_number);