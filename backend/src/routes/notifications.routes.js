const router = require('express').Router();
const { requireAuth } = require('../middleware/auth.middleware');
const notifications = require('../controllers/notifications.controller');

router.use(requireAuth);
router.get('/', notifications.listMyNotifications);
router.get('/unread-count', notifications.unreadCount);
router.patch('/read-all', notifications.markAllRead);
router.patch('/:id/read', notifications.markRead);

module.exports = router;