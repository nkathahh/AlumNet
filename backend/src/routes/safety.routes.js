const router = require('express').Router();
const { dbRateLimit } = require('../utils/rateLimit');
const { requireAuth } = require('../middleware/auth.middleware');
const safety = require('../controllers/safety.controller');

// Reports are free to send but not to spam
const reportLimit = dbRateLimit('reports', {
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'You have sent a lot of reports. Please wait an hour or contact the alumni office.' }
});

router.use(requireAuth);
router.post('/reports', reportLimit, safety.createReport);
router.get('/blocks', safety.listBlocks);
router.post('/blocks/:id', safety.blockUser);
router.delete('/blocks/:id', safety.unblockUser);

module.exports = router;
