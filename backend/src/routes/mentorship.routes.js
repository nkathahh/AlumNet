const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const mentorship = require('../controllers/mentorship.controller');

router.post('/', requireAuth, mentorship.createRequest);
router.get('/', requireAuth, mentorship.listMyRequests);
router.patch('/:id', requireAuth, mentorship.respondToRequest);
router.delete('/:id', requireAuth, mentorship.withdrawRequest);
router.post('/:id/end', requireAuth, mentorship.endMentorship);

const ws = require('../controllers/workspace.controller');
router.get('/:id/workspace', requireAuth, ws.getWorkspace);
router.post('/:id/goals', requireAuth, ws.addGoal);
router.patch('/:id/goals/:goalId', requireAuth, ws.updateGoal);
router.delete('/:id/goals/:goalId', requireAuth, ws.deleteGoal);
router.post('/:id/meetings', requireAuth, ws.logMeeting);
router.delete('/:id/meetings/:meetingId', requireAuth, ws.deleteMeeting);
router.post('/:id/feedback', requireAuth, ws.giveFeedback);
module.exports = router;