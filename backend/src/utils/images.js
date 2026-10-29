/*
 * Turning an upload into safe, small images.
 *
 * Every upload is decoded and drawn again as WebP at fixed sizes. That does
 * four things at once: it proves the file really is a picture (whatever its
 * name or declared type says), it removes hidden data such as the GPS
 * location phones add, it turns photos the right way up, and it keeps pages
 * fast however large the original was. The original is never kept.
 */
const crypto = require('crypto');
const sharp = require('sharp');
const pool = require('../config/db');
const { storage } = require('./storage');

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Sizes kept for each kind of image. The largest is used when a size is not asked for.
const KINDS = {
  avatar: { sizes: [96, 320], shape: 'square', min: 96, label: 'profile photo' },
  event_banner: { sizes: [640, 1280], shape: 'banner', min: 600, label: 'event banner' },
  event_photo: { sizes: [480, 1600], shape: 'free', min: 400, label: 'event photo' },
  logo: { sizes: [96, 256], shape: 'logo', min: 64, label: 'logo' },
  report_evidence: { sizes: [1600], shape: 'free', min: 1, label: 'screenshot' },
  // The organisation's logo: a square icon (sidebar badge and browser tab) and a wide version
  brand: { sizes: [64, 192, 640], shape: 'brand', min: 48, label: 'organisation logo' }
};

class ImageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function resizeFor(shape, size) {
  if (shape === 'square') return { width: size, height: size, fit: 'cover', position: 'attention' };
  if (shape === 'banner') return { width: size, height: Math.round(size * 3 / 8), fit: 'cover', position: 'attention' };
  // Logos are never cropped: they sit on white inside a square
  if (shape === 'logo' || (shape === 'brand' && size < 640)) return { width: size, height: size, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } };
  if (shape === 'brand') return { width: size, height: 200, fit: 'inside', withoutEnlargement: true };
  return { width: size, height: size, fit: 'inside', withoutEnlargement: true };
}

// Returns the WebP files to store, or throws an ImageError a member can act on
async function processUpload(buffer, kind) {
  const spec = KINDS[kind];
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImageError('Choose a JPG, PNG or WebP image.', 415);
  if (buffer.length > MAX_UPLOAD_BYTES) throw new ImageError('That image is over 5 MB. Choose a smaller one.', 413);

  let meta;
  try {
    // A limit on pixels stops a tiny file that expands to a huge picture
    meta = await sharp(buffer, { failOn: 'error', limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw new ImageError('That file is not an image AlumNet can read. Choose a JPG, PNG or WebP image.', 415);
  }
  if (!['jpeg', 'png', 'webp'].includes(meta.format)) {
    throw new ImageError('Choose a JPG, PNG or WebP image.', 415);
  }
  // Width and height as the photo will be shown, after turning it the right way up
  const turned = (meta.orientation || 1) >= 5;
  const width = turned ? meta.height : meta.width;
  const height = turned ? meta.width : meta.height;
  if (Math.min(width, height) < spec.min && kind !== 'report_evidence') {
    throw new ImageError(`That image is too small for a ${spec.label}. Use one at least ${spec.min} pixels across.`);
  }

  const files = [];
  for (const size of spec.sizes) {
    let img = sharp(buffer, { failOn: 'error', limitInputPixels: 50_000_000, pages: 1 })
      .rotate(); // uses the phone's orientation, then the orientation data is dropped with the rest
    // Empty margins around a logo are cut away, so it fills its space
    if (spec.shape === 'brand') img = img.trim({ threshold: 12 });
    img = img.resize(resizeFor(spec.shape, size));
    if (spec.shape === 'logo' || spec.shape === 'brand') img = img.flatten({ background: '#ffffff' });
    const { data, info } = await img.webp({ quality: kind === 'report_evidence' ? 85 : 80 }).toBuffer({ resolveWithObject: true });
    files.push({ size, data, width: info.width, height: info.height });
  }
  return files;
}

function newKey() {
  return crypto.randomBytes(16).toString('hex');
}

// Stores the files and records the image. Returns the new image row.
async function saveImage({ buffer, kind, uploadedBy, status, eventId = null, opportunityId = null, reportId = null, caption = null }) {
  const files = await processUpload(buffer, kind);
  const key = newKey();
  const store = storage();
  const written = [];
  try {
    for (const f of files) {
      await store.put(`${key}-${f.size}.webp`, f.data);
      written.push(`${key}-${f.size}.webp`);
    }
  } catch (err) {
    await Promise.all(written.map((n) => store.remove(n).catch(() => null)));
    throw err;
  }
  const largest = files[files.length - 1];
  const [result] = await pool.execute(
    `INSERT INTO images (storage_key, kind, uploaded_by, event_id, opportunity_id, report_id, status, caption, width, height, bytes)
     VALUES (:key, :kind, :uploadedBy, :eventId, :opportunityId, :reportId, :status, :caption, :width, :height, :bytes)`,
    { key, kind, uploadedBy, eventId, opportunityId, reportId, status, caption, width: largest.width, height: largest.height, bytes: files.reduce((t, f) => t + f.data.length, 0) }
  );
  return { image_id: result.insertId, storage_key: key, kind, status };
}

// Removes an image's files and its row. Files first, so nothing is left unreachable but stored.
async function deleteImage(imageOrKey) {
  const key = typeof imageOrKey === 'string' ? imageOrKey : imageOrKey && imageOrKey.storage_key;
  if (!key) return;
  const [[img]] = await pool.execute('SELECT kind FROM images WHERE storage_key = :key', { key });
  const kind = img ? img.kind : null;
  const sizes = kind ? KINDS[kind].sizes : [...new Set(Object.values(KINDS).flatMap((k) => k.sizes))];
  await Promise.all(sizes.map((s) => storage().remove(`${key}-${s}.webp`).catch((err) => console.error('Image file not removed:', err.message))));
  await pool.execute('DELETE FROM images WHERE storage_key = :key', { key });
}

// Address of an image for pages, at the nearest stored size at or above the one asked for
function imageUrl(key, kind, want) {
  if (!key) return null;
  const sizes = (KINDS[kind] || KINDS.event_photo).sizes;
  const size = sizes.find((s) => s >= (want || 0)) || sizes[sizes.length - 1];
  return `/media/${key}-${size}.webp`;
}

const avatarUrl = (key, want = 96) => imageUrl(key, 'avatar', want);

/*
 * Images whose event, post or report has gone, and report screenshots left
 * behind, are removed by the clean-up job.
 */
async function removeOrphanImages() {
  const [rows] = await pool.query(`
    SELECT storage_key FROM images
    WHERE (kind IN ('event_banner','event_photo') AND event_id IS NULL)
       OR (kind = 'logo' AND opportunity_id IS NULL)
       OR (kind = 'report_evidence' AND report_id IS NULL)
       OR (kind = 'avatar' AND uploaded_by IS NULL)
       OR (kind = 'report_evidence' AND report_id IN (SELECT report_id FROM reports WHERE status <> 'open'))`);
  for (const r of rows) await deleteImage(r.storage_key);
  return rows.length;
}

module.exports = { KINDS, ACCEPTED_TYPES, MAX_UPLOAD_BYTES, ImageError, processUpload, saveImage, deleteImage, imageUrl, avatarUrl, removeOrphanImages };
