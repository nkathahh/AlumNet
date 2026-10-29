-- 026: The organisation's logo
-- An admin can upload the logo shown in the sidebar, on the sign-in pages and
-- as the browser tab icon, in place of the "KQ" letters. It is the one image
-- shown before signing in, so it is served to everyone.

ALTER TABLE images MODIFY kind ENUM('avatar','event_banner','event_photo','logo','report_evidence','brand') NOT NULL;
