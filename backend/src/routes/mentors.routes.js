const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth.middleware');
const mentors = require('../controllers/mentors.controller');

router.get('/', requireAuth, requireRole('mentee', 'admin'), mentors.listMentors);

module.exports = router;
