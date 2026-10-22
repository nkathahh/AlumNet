const router = require('express').Router();
const { requireAuth } = require('../middleware/auth.middleware');
const opportunities = require('../controllers/opportunities.controller');

router.use(requireAuth);
router.get('/', opportunities.listOpportunities);
router.get('/mine', opportunities.listMyPosts);
router.post('/', opportunities.createOpportunity);
router.put('/:id', opportunities.resubmitOpportunity);

module.exports = router;