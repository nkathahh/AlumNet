const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const profileController = require('../controllers/profile.controller');

router.get('/me', requireAuth, profileController.getMyProfile);
router.put('/me', requireAuth, profileController.updateMyProfile);
router.get('/:id', requireAuth, profileController.getPublicProfile);

module.exports = router;