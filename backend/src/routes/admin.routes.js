const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, requireAdminTwoFactor } = require('../middleware/auth.middleware');
const admin = require('../controllers/admin.controller');
const safety = require('../controllers/safety.controller');
const moderation = require('../controllers/moderation.controller');

// Every admin tool needs an admin session with two-factor turned on
router.use(requireAuth, requireRole('admin'), requireAdminTwoFactor);

router.get('/stats', admin.getStats);
router.get('/users', admin.listUsers);
router.get('/users/:id', admin.getUserDetail);
router.get('/impact', require('../controllers/impact.controller').getImpact);
router.patch('/users/:id/toggle-status', admin.toggleUserStatus);

router.get('/signup-requests', admin.listSignupRequests);
router.patch('/signup-requests/:id/review', admin.reviewSignupRequest);

router.post('/hr/preview', admin.previewHrImport);
router.post('/hr/apply', admin.applyHrImport);
router.get('/hr/requests', admin.listHrImportRequests);
router.post('/hr/requests/:id/decision', admin.decideHrImport);

router.get('/events/pending', admin.listPendingEvents);
router.patch('/events/:id/review', admin.reviewEvent);
router.get('/events', admin.listEvents);
router.post('/events', admin.createEvent);
router.delete('/events/:id', admin.deleteEvent);
router.put('/events/:id', admin.updateEvent);
router.post('/events/:id/cancel', require('../controllers/events.controller').cancelEvent);

router.get('/opportunities/pending', admin.listPendingOpportunities);
router.patch('/opportunities/:id/review', admin.reviewOpportunity);

router.get('/moderation', moderation.getQueue);
router.get('/moderation/insights', moderation.insights);
router.get('/moderation/learned', moderation.listLearned);
router.post('/moderation/approve-clean', moderation.approveClean);
router.put('/moderation/settings', moderation.setAutoApprove);
router.delete('/moderation/blocked/:id', moderation.unblockIndicator);
router.delete('/moderation/known/:domain', moderation.forgetKnownSite);
router.post('/moderation/:kind/:id/decision', moderation.decide);

router.get('/reports', safety.listReports);
router.post('/reports/resolve', safety.resolveReports);

router.get('/activity-logs', admin.listActivityLogs);

module.exports = router;
