const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const mentorship = require('../controllers/mentorship.controller');

router.post('/', requireAuth, mentorship.createRequest);
router.get('/', requireAuth, mentorship.listMyRequests);
router.patch('/:id', requireAuth, mentorship.respondToRequest);
router.delete('/:id', requireAuth, mentorship.withdrawRequest);
router.post('/:id/end', requireAuth, mentorship.endMentorship);

module.exports = router;