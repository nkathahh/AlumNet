const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const { getRecommendations } = require('../controllers/recommendations.controller');

router.get('/', requireAuth, getRecommendations);

module.exports = router;