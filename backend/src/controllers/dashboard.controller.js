const pool = require('../config/db');

async function getMenteeSummary(req, res, next) {
  try {
    const { userId, role } = req.user;
    if (role !== 'mentee') return res.status(403).json({ error: 'Mentee access only' });

    const [[{ activeCount }]] = await pool.execute(
      `SELECT COUNT(*) AS activeCount FROM mentorship_requests WHERE mentee_id = :userId AND status = 'accepted'`,
      { userId }
    );
    const [[{ pendingCount }]] = await pool.execute(
      `SELECT COUNT(*) AS pendingCount FROM mentorship_requests WHERE mentee_id = :userId AND status = 'pending'`,
      { userId }
    );
    const [[{ profileComplete }]] = await pool.execute(
      `SELECT (skills IS NOT NULL AND skills != '' AND experience IS NOT NULL AND experience != ''
               AND career_interests IS NOT NULL AND career_interests != '') AS profileComplete
       FROM profiles WHERE user_id = :userId`,
      { userId }
    );

    res.json({
      activeMentorships: activeCount,
      pendingRequests: pendingCount,
      profileComplete: !!profileComplete
    });
  } catch (err) { next(err); }
}

module.exports = { getMenteeSummary };