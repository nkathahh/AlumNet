const router = require('express').Router();
const { requireAuth } = require('../middleware/auth.middleware');
const events = require('../controllers/events.controller');

router.use(requireAuth);
router.get('/', events.listEvents);
router.get('/my-proposals', events.listMyProposals);
router.post('/', events.proposeEvent);
router.put('/:id', events.resubmitEvent);
router.post('/:id/register', events.registerForEvent);
router.delete('/:id/register', events.cancelRegistration);

module.exports = router;