const router = require('express').Router();

const { requireAuth } = require('../middleware/auth.middleware');
const { listEvents, registerForEvent, cancelRegistration } = require('../controllers/events.controller');

router.use(requireAuth);
router.get('/', listEvents);
router.post('/:id/register', registerForEvent);
router.delete('/:id/register', cancelRegistration);

module.exports = router;