const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');

router.get('/', requireAuth, (req, res) => res.status(501).json({ error: 'Not implemented yet' }));

module.exports = router;