const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth.middleware');
const { rateLimit } = require('express-rate-limit');
const mentors = require('../controllers/mentors.controller');

// Each search makes the matching service do real work, and the directory lists
// people's details, so one account cannot hammer it or copy it all quickly
const directoryLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.userId}`,
  message: { error: 'You are searching very quickly. Please wait a minute and try again.' }
});

router.get('/', requireAuth, requireRole('mentee', 'admin'), directoryLimit, mentors.listMentors);

module.exports = router;
