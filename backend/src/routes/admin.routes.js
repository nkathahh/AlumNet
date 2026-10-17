const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth.middleware');
const admin = require('../controllers/admin.controller');

router.use(requireAuth, requireRole('admin'));

router.get('/stats', admin.getStats);
router.get('/users', admin.listUsers);
router.patch('/users/:id/toggle-status', admin.toggleUserStatus);

router.get('/events', admin.listEvents);
router.post('/events', admin.createEvent);
router.delete('/events/:id', admin.deleteEvent);

router.get('/opportunities/pending', admin.listPendingOpportunities);
router.patch('/opportunities/:id/review', admin.reviewOpportunity);

router.get('/activity-logs', admin.listActivityLogs);

router.get('/events/pending', admin.listPendingEvents);
router.patch('/events/:id/review', admin.reviewEvent);

module.exports = router;