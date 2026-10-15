const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const { getMenteeSummary } = require('../controllers/dashboard.controller');

router.get('/mentee-summary', requireAuth, getMenteeSummary);

module.exports = router;