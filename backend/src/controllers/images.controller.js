/*
 * Photos and images: profile photos, event banners, photos from past
 * events, company logos and screenshots attached to reports.
 *
 * Who sees what:
 * - Profile photos go live at once (they can be reported like a profile).
 * - Banners, logos and event photos from mentors wait for an admin, like
 *   posts. Admins' own uploads go live at once.
 * - Report screenshots are only ever shown to admins and the person who
 *   sent them, and are deleted when the report is closed.
 * - Every file is served through /media, which checks this for each request;
 *   only signed-in members can see any image.
 */
const pool = require('../config/db');
const { storage } = require('../utils/storage');
const { saveImage, deleteImage, imageUrl, avatarUrl, ImageError, KINDS } = require('../utils/images');
const { createNotification } = require('../utils/notify');

const logAdminAction = (...args) => require('./admin.controller').logAdminAction(...args);

const MAX_EVENT_PHOTOS = 30;
const MAX_EVENT_PHOTOS_EACH = 10;
const MAX_REPORT_SCREENSHOTS = 3;
const REPORT_SCREENSHOT_HOURS = 24;

const isAdmin = (req) => req.user.role === 'admin';
// "an event photo", "a logo"
const aOrAn = (word) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

// Upload errors become messages the member can act on; anything else goes to the error handler
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ImageError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
}

function caption(req) {
  const text = String(req.query.caption || '').trim().replace(/\s+/g, ' ');
  if (text.length > 150) throw new ImageError('Keep the caption under 150 characters.');
  return text || null;
}

/* ---------- Profile photo ---------- */

const setAvatar = handle(async (req, res) => {
  const { userId } = req.user;
  const img = await saveImage({ buffer: req.body, kind: 'avatar', uploadedBy: userId, status: 'live' });
  const [[u]] = await pool.execute('SELECT avatar_key FROM users WHERE user_id = :userId', { userId });
  await pool.execute('UPDATE users SET avatar_key = :key WHERE user_id = :userId', { key: img.storage_key, userId });
  if (u && u.avatar_key) await deleteImage(u.avatar_key);
  res.status(201).json({ message: 'Your photo is saved.', avatar_url: avatarUrl(img.storage_key, 320) });
});

const removeAvatar = handle(async (req, res) => {
  const { userId } = req.user;
  const [[u]] = await pool.execute('SELECT avatar_key FROM users WHERE user_id = :userId', { userId });
  if (!u || !u.avatar_key) return res.json({ message: 'You have no photo.' });
  await pool.execute('UPDATE users SET avatar_key = NULL WHERE user_id = :userId', { userId });
  await deleteImage(u.avatar_key);
  res.json({ message: 'Your photo is removed. Your initials show instead.' });
});

/* ---------- Event banner ---------- */

async function eventFor(req, id) {
  const [[e]] = await pool.execute('SELECT event_id, title, status, event_date, created_by, banner_key FROM events WHERE event_id = :id', { id });
  if (!e) return null;
  if (!isAdmin(req) && e.created_by !== req.user.userId) return null;
  return e;
}

const setEventBanner = handle(async (req, res) => {
  const id = Number(req.params.id);
  const event = await eventFor(req, id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (['cancelled', 'rejected'].includes(event.status)) return res.status(409).json({ error: 'This event can no longer be changed' });

  const admin = isAdmin(req);
  // A newer banner waiting for review replaces the older one
  const [waiting] = await pool.execute("SELECT storage_key FROM images WHERE kind = 'event_banner' AND event_id = :id AND status = 'pending'", { id });
  const img = await saveImage({ buffer: req.body, kind: 'event_banner', uploadedBy: req.user.userId, status: admin ? 'live' : 'pending', eventId: id });
  for (const w of waiting) await deleteImage(w.storage_key);
  if (admin) {
    await pool.execute('UPDATE events SET banner_key = :key WHERE event_id = :id', { key: img.storage_key, id });
    if (event.banner_key) await deleteImage(event.banner_key);
    return res.status(201).json({ status: 'live', message: 'Banner saved.', banner_url: imageUrl(img.storage_key, 'event_banner', 1280) });
  }
  res.status(201).json({ status: 'pending', message: 'Banner saved. The alumni office checks it before others see it.' });
});

const removeEventBanner = handle(async (req, res) => {
  const id = Number(req.params.id);
  const event = await eventFor(req, id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const [rows] = await pool.execute("SELECT storage_key FROM images WHERE kind = 'event_banner' AND event_id = :id", { id });
  await pool.execute('UPDATE events SET banner_key = NULL WHERE event_id = :id', { id });
  for (const r of rows) await deleteImage(r.storage_key);
  res.json({ message: 'Banner removed.' });
});

/* ---------- Photos from a past event ---------- */

async function canAddPhotos(req, event) {
  if (isAdmin(req) || event.created_by === req.user.userId) return true;
  const [[reg]] = await pool.execute('SELECT 1 AS yes FROM event_registrations WHERE event_id = :e AND user_id = :u', { e: event.event_id, u: req.user.userId });
  return Boolean(reg);
}

const addEventPhoto = handle(async (req, res) => {
  const id = Number(req.params.id);
  const [[event]] = await pool.execute('SELECT event_id, title, status, event_date, created_by FROM events WHERE event_id = :id', { id });
  if (!event || event.status !== 'approved') return res.status(404).json({ error: 'Event not found' });
  if (new Date(event.event_date) > new Date()) return res.status(409).json({ error: 'Photos can be added once the event has taken place.' });
  if (!(await canAddPhotos(req, event))) return res.status(403).json({ error: 'Only the organiser and people who registered can add photos.' });
  // Photos of people are their personal data: the uploader confirms they agreed
  if (req.query.consent !== '1') {
    return res.status(400).json({ error: 'Confirm that everyone clearly shown agreed to the photo being shared.' });
  }
  const text = caption(req);
  const [[counts]] = await pool.execute(
    `SELECT COUNT(*) AS total, SUM(uploaded_by = :u) AS mine FROM images WHERE kind = 'event_photo' AND event_id = :id`,
    { id, u: req.user.userId }
  );
  if (Number(counts.total) >= MAX_EVENT_PHOTOS) return res.status(409).json({ error: `This event already has ${MAX_EVENT_PHOTOS} photos.` });
  if (Number(counts.mine || 0) >= MAX_EVENT_PHOTOS_EACH && !isAdmin(req)) {
    return res.status(409).json({ error: `You can add up to ${MAX_EVENT_PHOTOS_EACH} photos to one event.` });
  }
  const live = isAdmin(req);
  const img = await saveImage({ buffer: req.body, kind: 'event_photo', uploadedBy: req.user.userId, status: live ? 'live' : 'pending', eventId: id, caption: text });
  res.status(201).json({
    image_id: img.image_id,
    status: img.status,
    message: live ? 'Photo added.' : 'Photo added. The alumni office checks it before others see it.'
  });
});

const listEventPhotos = handle(async (req, res) => {
  const id = Number(req.params.id);
  const [[event]] = await pool.execute('SELECT event_id, status, event_date, created_by FROM events WHERE event_id = :id', { id });
  if (!event || (event.status !== 'approved' && !isAdmin(req) && event.created_by !== req.user.userId)) return res.status(404).json({ error: 'Event not found' });
  const [rows] = await pool.execute(
    `SELECT i.image_id, i.storage_key, i.status, i.caption, i.width, i.height, i.created_at, i.uploaded_by, u.name AS uploaded_by_name
     FROM images i LEFT JOIN users u ON u.user_id = i.uploaded_by
     WHERE i.kind = 'event_photo' AND i.event_id = :id AND (i.status = 'live' OR i.uploaded_by = :me OR :admin = 1)
     ORDER BY i.created_at`,
    { id, me: req.user.userId, admin: isAdmin(req) ? 1 : 0 }
  );
  res.json({
    can_add: event.status === 'approved' && new Date(event.event_date) <= new Date() && (await canAddPhotos(req, event)),
    photos: rows.map((r) => ({
      image_id: r.image_id,
      status: r.status,
      caption: r.caption,
      width: r.width,
      height: r.height,
      uploaded_by_name: r.uploaded_by_name || 'A former member',
      is_mine: r.uploaded_by === req.user.userId,
      thumb_url: imageUrl(r.storage_key, 'event_photo', 480),
      url: imageUrl(r.storage_key, 'event_photo', 1600)
    }))
  });
});

/* ---------- Company logo ---------- */

const setLogo = handle(async (req, res) => {
  const id = Number(req.params.id);
  const [[post]] = await pool.execute(
    'SELECT opportunity_id, posted_by, approval_status, closed_at, logo_key FROM career_opportunities WHERE opportunity_id = :id',
    { id }
  );
  if (!post || (post.posted_by !== req.user.userId && !isAdmin(req))) return res.status(404).json({ error: 'Post not found' });
  if (post.closed_at || post.approval_status === 'rejected') return res.status(409).json({ error: 'This post can no longer be changed' });
  const admin = isAdmin(req);
  const [waiting] = await pool.execute("SELECT storage_key FROM images WHERE kind = 'logo' AND opportunity_id = :id AND status = 'pending'", { id });
  const img = await saveImage({ buffer: req.body, kind: 'logo', uploadedBy: req.user.userId, status: admin ? 'live' : 'pending', opportunityId: id });
  for (const w of waiting) await deleteImage(w.storage_key);
  if (admin) {
    await pool.execute('UPDATE career_opportunities SET logo_key = :key WHERE opportunity_id = :id', { key: img.storage_key, id });
    if (post.logo_key) await deleteImage(post.logo_key);
    return res.status(201).json({ status: 'live', message: 'Logo saved.' });
  }
  res.status(201).json({ status: 'pending', message: 'Logo saved. The alumni office checks it before others see it.' });
});

const removeLogo = handle(async (req, res) => {
  const id = Number(req.params.id);
  const [[post]] = await pool.execute('SELECT posted_by FROM career_opportunities WHERE opportunity_id = :id', { id });
  if (!post || (post.posted_by !== req.user.userId && !isAdmin(req))) return res.status(404).json({ error: 'Post not found' });
  const [rows] = await pool.execute("SELECT storage_key FROM images WHERE kind = 'logo' AND opportunity_id = :id", { id });
  await pool.execute('UPDATE career_opportunities SET logo_key = NULL WHERE opportunity_id = :id', { id });
  for (const r of rows) await deleteImage(r.storage_key);
  res.json({ message: 'Logo removed.' });
});

/* ---------- Screenshots attached to a report ---------- */

const addReportScreenshot = handle(async (req, res) => {
  const id = Number(req.params.id);
  const [[report]] = await pool.execute(
    `SELECT report_id, status, (created_at > DATE_SUB(NOW(), INTERVAL ${REPORT_SCREENSHOT_HOURS} HOUR)) AS recent
     FROM reports WHERE report_id = :id AND reporter_id = :u`,
    { id, u: req.user.userId }
  );
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.status !== 'open') return res.status(409).json({ error: 'This report has already been reviewed.' });
  if (!Number(report.recent)) return res.status(409).json({ error: `Screenshots can be added within ${REPORT_SCREENSHOT_HOURS} hours of sending a report.` });
  const [[{ n }]] = await pool.execute("SELECT COUNT(*) AS n FROM images WHERE kind = 'report_evidence' AND report_id = :id", { id });
  if (Number(n) >= MAX_REPORT_SCREENSHOTS) return res.status(409).json({ error: `You can attach up to ${MAX_REPORT_SCREENSHOTS} screenshots.` });
  await saveImage({ buffer: req.body, kind: 'report_evidence', uploadedBy: req.user.userId, status: 'live', reportId: id });
  res.status(201).json({ message: 'Screenshot attached. Only the alumni office can see it.' });
});

/* ---------- Removing an image ---------- */

/*
 * The uploader can remove their own photo; an admin can remove any image
 * (an unsuitable profile photo, say), and the owner is told why.
 */
const removeImage = handle(async (req, res) => {
  const id = Number(req.params.id);
  const [[img]] = await pool.execute(
    `SELECT i.image_id, i.storage_key, i.kind, i.uploaded_by, i.event_id, i.opportunity_id, e.title AS event_title
     FROM images i LEFT JOIN events e ON e.event_id = i.event_id WHERE i.image_id = :id`,
    { id }
  );
  const admin = isAdmin(req);
  if (!img || (img.uploaded_by !== req.user.userId && !admin) || img.kind === 'report_evidence') return res.status(404).json({ error: 'Image not found' });
  const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
  const byOther = admin && img.uploaded_by !== req.user.userId;
  if (byOther && !note) return res.status(400).json({ error: 'Add a short note saying why. The member is told.' });

  if (img.kind === 'avatar') await pool.execute('UPDATE users SET avatar_key = NULL WHERE avatar_key = :k', { k: img.storage_key });
  if (img.kind === 'event_banner') await pool.execute('UPDATE events SET banner_key = NULL WHERE banner_key = :k', { k: img.storage_key });
  if (img.kind === 'logo') await pool.execute('UPDATE career_opportunities SET logo_key = NULL WHERE logo_key = :k', { k: img.storage_key });
  await deleteImage(img.storage_key);

  if (byOther) {
    const what = KINDS[img.kind].label;
    if (img.uploaded_by) await createNotification(img.uploaded_by, 'image_removed', `The alumni office removed your ${what}${img.event_title ? ` for "${img.event_title}"` : ''}: ${note}`, 'notifications.html');
    if (img.kind === 'avatar') {
      const [[owner]] = await pool.execute('SELECT name FROM users WHERE user_id = :u', { u: img.uploaded_by });
      await logAdminAction(req.user.userId, 'image_removed', 'users', img.uploaded_by, `Removed the profile photo of ${owner ? owner.name : 'a member'}. Note: ${note}`, owner ? owner.name : null);
    } else {
      await logAdminAction(req.user.userId, 'image_removed', 'images', id, `Removed ${aOrAn(what)}. Note: ${note}`, img.event_title || null);
    }
  }
  res.json({ message: 'Removed.' });
});

/* ---------- Admin review of images waiting ---------- */

const listPending = handle(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT i.image_id, i.storage_key, i.kind, i.caption, i.created_at, i.width, i.height,
           u.user_id AS uploaded_by, u.name AS uploaded_by_name,
           e.event_id, e.title AS event_title, e.status AS event_status,
           co.opportunity_id, co.title AS opportunity_title, co.company, co.approval_status AS opportunity_status
    FROM images i
    LEFT JOIN users u ON u.user_id = i.uploaded_by
    LEFT JOIN events e ON e.event_id = i.event_id
    LEFT JOIN career_opportunities co ON co.opportunity_id = i.opportunity_id
    WHERE i.status = 'pending'
    ORDER BY i.created_at ASC`);
  res.json(rows.map((r) => ({
    image_id: r.image_id,
    kind: r.kind,
    label: KINDS[r.kind].label,
    caption: r.caption,
    created_at: r.created_at,
    uploaded_by_name: r.uploaded_by_name || 'A former member',
    for_title: r.event_title || (r.opportunity_title ? `${r.opportunity_title}${r.company ? `, ${r.company}` : ''}` : null),
    for_status: r.event_status || r.opportunity_status || null,
    url: imageUrl(r.storage_key, r.kind, 1280)
  })));
});

const decidePending = handle(async (req, res) => {
  const id = Number(req.params.id);
  const { decision } = req.body || {};
  const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject' });
  if (decision === 'reject' && !note) return res.status(400).json({ error: 'Add a short note saying why. The member is told.' });
  const [[img]] = await pool.execute(
    `SELECT i.*, e.title AS event_title, e.banner_key AS old_banner, co.title AS opp_title, co.logo_key AS old_logo
     FROM images i LEFT JOIN events e ON e.event_id = i.event_id LEFT JOIN career_opportunities co ON co.opportunity_id = i.opportunity_id
     WHERE i.image_id = :id AND i.status = 'pending'`,
    { id }
  );
  if (!img) return res.status(404).json({ error: 'This image has already been reviewed' });
  const what = KINDS[img.kind].label;
  const title = img.event_title || img.opp_title || '';

  if (decision === 'reject') {
    await deleteImage(img.storage_key);
    if (img.uploaded_by) await createNotification(img.uploaded_by, 'image_rejected', `Your ${what}${title ? ` for "${title}"` : ''} was not approved: ${note}`, 'notifications.html');
    await logAdminAction(req.user.userId, 'image_rejected', 'images', id, `Rejected ${aOrAn(what)}. Note: ${note}`, title || null);
    return res.json({ message: 'Rejected. The member has been told.' });
  }

  await pool.execute("UPDATE images SET status = 'live', reviewed_by = :by, reviewed_at = NOW() WHERE image_id = :id", { id, by: req.user.userId });
  if (img.kind === 'event_banner') {
    await pool.execute('UPDATE events SET banner_key = :k WHERE event_id = :e', { k: img.storage_key, e: img.event_id });
    if (img.old_banner && img.old_banner !== img.storage_key) await deleteImage(img.old_banner);
  }
  if (img.kind === 'logo') {
    await pool.execute('UPDATE career_opportunities SET logo_key = :k WHERE opportunity_id = :o', { k: img.storage_key, o: img.opportunity_id });
    if (img.old_logo && img.old_logo !== img.storage_key) await deleteImage(img.old_logo);
  }
  if (img.uploaded_by) await createNotification(img.uploaded_by, 'image_approved', `Your ${what}${title ? ` for "${title}"` : ''} is now live.`, img.kind === 'logo' ? 'opportunities.html' : 'events.html');
  await logAdminAction(req.user.userId, 'image_approved', 'images', id, `Approved ${aOrAn(what)}`, title || null);
  res.json({ message: 'Approved. It is now live.' });
});

/* ---------- The organisation's logo ---------- */

async function brandSetting() {
  const [rows] = await pool.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('brand_logo_key', 'brand_logo_wide')");
  const map = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  return map.brand_logo_key ? { key: map.brand_logo_key, wide: map.brand_logo_wide === '1' } : null;
}

// What every page needs to show the logo (null means the "KQ" letters)
async function brandInfo() {
  const b = await brandSetting();
  if (!b) return null;
  return {
    icon_url: `/brand/${b.key}-64.webp`,
    square_url: `/brand/${b.key}-192.webp`,
    wide_url: `/brand/${b.key}-640.webp`,
    wide: b.wide
  };
}

async function saveSetting(key, value, adminId) {
  await pool.execute(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (:key, :value, :adminId)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    { key, value, adminId }
  );
}

const setBrandLogo = handle(async (req, res) => {
  const img = await saveImage({ buffer: req.body, kind: 'brand', uploadedBy: req.user.userId, status: 'live' });
  // A logo at least twice as wide as it is tall is shown above the AlumNet name; a squarer one replaces the badge
  const [[row]] = await pool.execute('SELECT width, height FROM images WHERE image_id = :id', { id: img.image_id });
  const wide = row.width >= row.height * 2;
  const old = await brandSetting();
  await saveSetting('brand_logo_key', img.storage_key, req.user.userId);
  await saveSetting('brand_logo_wide', wide ? '1' : '0', req.user.userId);
  if (old) await deleteImage(old.key);
  await logAdminAction(req.user.userId, 'settings', 'app_settings', 0, 'Changed the organisation logo', 'Organisation logo');
  res.status(201).json({ message: 'Logo saved. It now shows on every page.', brand: await brandInfo() });
});

const removeBrandLogo = handle(async (req, res) => {
  const old = await brandSetting();
  if (!old) return res.json({ message: 'There is no logo to remove.' });
  await pool.execute("DELETE FROM app_settings WHERE setting_key IN ('brand_logo_key', 'brand_logo_wide')");
  await deleteImage(old.key);
  await logAdminAction(req.user.userId, 'settings', 'app_settings', 0, 'Removed the organisation logo (back to the KQ letters)', 'Organisation logo');
  res.json({ message: 'Logo removed. The KQ letters show again.' });
});

// GET /brand/<key>-<size>.webp: the logo, for everyone (it appears on the sign-in pages)
async function serveBrand(req, res, next) {
  try {
    const m = /^([a-f0-9]{32})-(\d{2,4})\.webp$/.exec(req.params.file || '');
    if (!m || !KINDS.brand.sizes.includes(Number(m[2]))) return res.status(404).end();
    const [[img]] = await pool.execute("SELECT storage_key FROM images WHERE storage_key = :k AND kind = 'brand'", { k: m[1] });
    if (!img) return res.status(404).end();
    const stream = await storage().get(req.params.file);
    if (!stream) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

/* ---------- Serving files ---------- */

async function canView(user, img) {
  if (user.role === 'admin' || img.uploaded_by === user.userId) return true;
  if (img.kind === 'report_evidence') return false;
  return img.status === 'live';
}

/*
 * GET /media/<key>-<size>.webp
 * Members only. Images that are live are cached by the browser for a day
 * (the address changes whenever an image is replaced, so this is safe);
 * anything private is never cached.
 */
async function serveMedia(req, res, next) {
  try {
    const m = /^([a-f0-9]{32})-(\d{2,4})\.webp$/.exec(req.params.file || '');
    if (!m) return res.status(404).end();
    const [[img]] = await pool.execute('SELECT storage_key, kind, status, uploaded_by FROM images WHERE storage_key = :k', { k: m[1] });
    if (!img || !KINDS[img.kind].sizes.includes(Number(m[2])) || !(await canView(req.user, img))) return res.status(404).end();
    const stream = await storage().get(req.params.file);
    if (!stream) return res.status(404).end();
    const open = img.status === 'live' && img.kind !== 'report_evidence';
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', open ? 'private, max-age=86400, immutable' : 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Even if a file were ever not an image, it could not run as a page
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    stream.on('error', (err) => { console.error('Image read failed:', err.message); if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  setAvatar, removeAvatar, setEventBanner, removeEventBanner, addEventPhoto, listEventPhotos,
  setLogo, removeLogo, addReportScreenshot, removeImage, listPending, decidePending, serveMedia,
  setBrandLogo, removeBrandLogo, serveBrand, brandInfo,
  MAX_EVENT_PHOTOS, MAX_REPORT_SCREENSHOTS
};
