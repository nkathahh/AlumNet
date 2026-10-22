const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, requireAdminTwoFactor } = require('../middleware/auth.middleware');
const admin = require('../controllers/admin.controller');
const safety = require('../controllers/safety.controller');

// Every admin tool needs an admin session with two-factor turned on
router.use(requireAuth, requireRole('admin'), requireAdminTwoFactor);

router.get('/stats', admin.getStats);
router.get('/users', admin.listUsers);
router.patch('/users/:id/toggle-status', admin.toggleUserStatus);

router.get('/signup-requests', admin.listSignupRequests);
router.patch('/signup-requests/:id/review', admin.reviewSignupRequest);

router.post('/hr/preview', admin.previewHrImport);
router.post('/hr/apply', admin.applyHrImport);

router.get('/events/pending', admin.listPendingEvents);
router.patch('/events/:id/review', admin.reviewEvent);
router.get('/events', admin.listEvents);
router.post('/events', admin.createEvent);
router.delete('/events/:id', admin.deleteEvent);

router.get('/opportunities/pending', admin.listPendingOpportunities);
router.patch('/opportunities/:id/review', admin.reviewOpportunity);

router.get('/reports', safety.listReports);
router.post('/reports/resolve', safety.resolveReports);

router.get('/activity-logs', admin.listActivityLogs);

module.exports = router;
