const router = require('express').Router();
const { requireAuth } = require('../middleware/auth.middleware');
const events = require('../controllers/events.controller');

router.use(requireAuth);
router.get('/', events.listEvents);
router.get('/my-proposals', events.listMyProposals);
router.get('/departments', events.listDepartments);
router.post('/', events.proposeEvent);
router.put('/:id', events.updateEvent);
router.post('/:id/cancel', events.cancelEvent);
router.post('/:id/register', events.registerForEvent);
router.delete('/:id/register', events.cancelRegistration);
router.post('/:id/waitlist', events.joinWaitlist);
router.delete('/:id/waitlist', events.leaveWaitlist);

module.exports = router;