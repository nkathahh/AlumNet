const axios = require('axios');
const pool = require('../config/db');

const MATCHING_FIELDS = ['skills', 'experience', 'career_interests'];

async function getRecommendations(req, res, next) {
  try {
    const { userId, role } = req.user;
    if (role !== 'mentee') return res.status(403).json({ error: 'Mentor recommendations are for mentees' });

    // Matching needs the three fields the model reads; say exactly what is missing
    const [[profile]] = await pool.execute(
      'SELECT skills, experience, career_interests FROM profiles WHERE user_id = :userId',
      { userId }
    );
    const missing = MATCHING_FIELDS.filter((f) => !profile || !String(profile[f] || '').trim());
    if (missing.length) {
      return res.status(409).json({
        code: 'profile_incomplete',
        missing,
        error: 'Add your skills, experience and career interests to see mentor matches.'
      });
    }

    const base = (process.env.ML_SERVICE_URL || 'http://localhost:5000').replace(/\/$/, '');
    const url = `${base}/recommend?mentee_id=${userId}`;
    // The shared key stops anyone else calling the ML service directly once it is online
    const headers = process.env.ML_API_KEY ? { 'X-API-Key': process.env.ML_API_KEY } : {};
    const response = await axios.get(url, { headers, timeout: 30000 });
    // Never suggest someone either person has blocked
    const [blocked] = await pool.execute(
      `SELECT blocked_id AS id FROM user_blocks WHERE blocker_id = :userId
       UNION SELECT blocker_id AS id FROM user_blocks WHERE blocked_id = :userId`,
      { userId }
    );
    const hidden = new Set(blocked.map((b) => b.id));
    res.json((response.data || []).filter((m) => !hidden.has(m.mentor_id)));
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED') {
      return res.status(503).json({ error: 'The matching service is starting up. Please try again in a minute.' });
    }
    next(err);
  }
}

module.exports = { getRecommendations };
