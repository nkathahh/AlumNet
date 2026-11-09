const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, requireAdminTwoFactor } = require('../middleware/auth.middleware');
const { dbRateLimit } = require('../utils/rateLimit');
const { ACCEPTED_TYPES, MAX_UPLOAD_BYTES } = require('../utils/images');
const images = require('../controllers/images.controller');

// Uploads arrive as the raw image (the browser sends the file itself, not a form).
// Anything that does not say it is a JPG, PNG or WebP is not read at all.
const imageBody = express.raw({ type: ACCEPTED_TYPES, limit: MAX_UPLOAD_BYTES });

// Processing images takes real work, so uploads have their own limit
const uploadLimit = dbRateLimit('uploads', {
  windowMs: 60 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.userId}`,
  message: { error: 'You have uploaded a lot of images in the last hour. Please wait a while and try again.' }
});
const upload = [uploadLimit, imageBody];

router.use(requireAuth);

router.post('/avatar', upload, images.setAvatar);
router.delete('/avatar', images.removeAvatar);
router.post('/events/:id/banner', upload, images.setEventBanner);
router.delete('/events/:id/banner', images.removeEventBanner);
router.get('/events/:id/photos', images.listEventPhotos);
router.post('/events/:id/photos', upload, images.addEventPhoto);
router.put('/events/:id/album', images.setEventAlbum);
router.put('/events/:id/cover', images.setEventCover);
router.post('/opportunities/:id/logo', upload, images.setLogo);
router.delete('/opportunities/:id/logo', images.removeLogo);
router.post('/reports/:id/screenshots', upload, images.addReportScreenshot);
// The organisation's logo, changed by admins
router.post('/brand', requireRole('admin'), requireAdminTwoFactor, upload, images.setBrandLogo);
router.delete('/brand', requireRole('admin'), requireAdminTwoFactor, images.removeBrandLogo);
router.delete('/:id', images.removeImage);

// Admin review of images waiting to go live
router.get('/pending', requireRole('admin'), requireAdminTwoFactor, images.listPending);
router.post('/pending/:id/decision', requireRole('admin'), requireAdminTwoFactor, images.decidePending);

module.exports = router;
