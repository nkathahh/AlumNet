const pool = require('../config/db');
const { mlGet } = require('../utils/ml');
const { cardsFor } = require('./mentors.controller');

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

    const { data } = await mlGet('/recommend', { mentee_id: userId });
    const matches = data || [];

    // Card details also apply blocks, HR status and availability
    const cards = new Map((await cardsFor(userId, matches.map((m) => m.mentor_id))).map((c) => [c.mentor_id, c]));
    const ranked = matches
      .filter((m) => cards.has(m.mentor_id))
      .map((m) => ({ ...m, ...cards.get(m.mentor_id), score: m.score }))
      // Only mentors who are taking mentees and have a free place are suggested
      .filter((m) => m.available)
      // Scores are compared in 2-point bands: within a band, the mentor with more
      // free places comes first, so the most popular mentors are not flooded
      .sort((a, b) => Math.floor(b.score / 2) - Math.floor(a.score / 2) || b.slots_left - a.slots_left || b.score - a.score);
    res.json(ranked.slice(0, 10));
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED') {
      return res.status(503).json({ error: 'The matching service is starting up. Please try again in a minute.' });
    }
    next(err);
  }
}

module.exports = { getRecommendations };
