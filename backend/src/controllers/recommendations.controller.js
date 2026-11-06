const pool = require('../config/db');
const { mlGet } = require('../utils/ml');
const { cardsFor } = require('./mentors.controller');
const { bandFor, topicOverlap } = require('../utils/fit');

const MATCHING_FIELDS = ['skills', 'experience', 'career_interests'];

/*
 * FR-11: what the mentee has done on AlumNet refines the order a little.
 * Only the mentee's own activity is used (their shortlist and the events they
 * registered for), never another member's, so nothing about a mentor's
 * activity is revealed. Signals add at most SIGNAL_CAP points to the ranking
 * score; the fit label still comes from the model's similarity alone.
 */
const SIGNAL_CAP = 4;
async function interactionSignals(menteeId, mentorIds) {
  const signals = new Map(mentorIds.map((id) => [id, { boost: 0, reasons: [] }]));
  if (!mentorIds.length) return signals;
  const params = { me: menteeId };
  mentorIds.forEach((id, i) => { params[`m${i}`] = id; });
  const marks = mentorIds.map((_, i) => `:m${i}`).join(', ');

  const [saved] = await pool.execute(`SELECT mentor_id FROM bookmarks WHERE mentee_id = :me AND mentor_id IN (${marks})`, params);
  for (const { mentor_id: id } of saved) {
    const s = signals.get(id);
    s.boost += 2;
    s.reasons.push('On your shortlist');
  }

  // Topics of approved events the mentee registered for in the last year
  const [events] = await pool.execute(
    `SELECT e.title, e.topics FROM event_registrations r JOIN events e ON e.event_id = r.event_id
     WHERE r.user_id = :me AND e.status = 'approved' AND e.topics IS NOT NULL AND e.topics <> ''
       AND e.event_date >= (NOW() - INTERVAL 365 DAY)
     ORDER BY e.event_date DESC LIMIT 10`,
    { me: menteeId }
  );
  if (events.length) {
    const [profiles] = await pool.execute(
      `SELECT u.user_id, u.department, p.headline, p.skills, p.experience
       FROM users u LEFT JOIN profiles p ON p.user_id = u.user_id WHERE u.user_id IN (${marks})`,
      params
    );
    for (const p of profiles) {
      const mentorText = [p.department, p.headline, p.skills, p.experience].filter(Boolean).join(' ');
      const matched = events.filter((e) => topicOverlap(e.topics, mentorText).length).slice(0, 2);
      const s = signals.get(p.user_id);
      if (!s || !matched.length) continue;
      s.boost += matched.length;
      s.reasons.push(`Matches ${matched.length === 1 ? 'the event' : 'events'} you joined: ${matched.map((e) => e.title).join(', ')}`);
    }
  }
  for (const s of signals.values()) s.boost = Math.min(SIGNAL_CAP, s.boost);
  return signals;
}

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
    const signals = await interactionSignals(userId, [...cards.keys()]);
    const ranked = matches
      .filter((m) => cards.has(m.mentor_id))
      .map((m) => {
        const sig = signals.get(m.mentor_id) || { boost: 0, reasons: [] };
        // The fit label reflects the profiles alone; the signals only reorder
        return { ...m, ...cards.get(m.mentor_id), score: m.score, fit: bandFor(m.score), rank_score: m.score + sig.boost, signals: sig.reasons };
      })
      // Only mentors who are taking mentees and have a free place are suggested
      .filter((m) => m.available)
      // Scores are compared in 2-point bands: within a band, the mentor with more
      // free places comes first, so the most popular mentors are not flooded
      .sort((a, b) => Math.floor(b.rank_score / 2) - Math.floor(a.rank_score / 2) || b.slots_left - a.slots_left || b.rank_score - a.rank_score);
    res.json(ranked.slice(0, 10));
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED') {
      return res.status(503).json({ error: 'The matching service is starting up. Please try again in a minute.' });
    }
    next(err);
  }
}

module.exports = { getRecommendations, interactionSignals, SIGNAL_CAP };
