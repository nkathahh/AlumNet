const pool = require('../config/db');

async function createRequest(req, res, next) {
    try {
        const { userId, role } = req.user;
        if (role !== 'mentee') return res.status(403).json({ error: 'Only mentees can send mentorship requests' });

        const { mentorId } = req.body;
        if (!mentorId) return res.status(400).json({ error: 'mentorId is required' });

        const [[existing]] = await pool.execute(
            `SELECT request_id FROM mentorship_requests WHERE mentee_id = :userId AND mentor_id = :mentorId AND status = 'pending'`,
            { userId, mentorId }
        );
        if (existing) return res.status(409).json({ error: 'You already have a pending request with this mentor' });

        const [result] = await pool.execute(
            `INSERT INTO mentorship_requests (mentee_id, mentor_id, status) VALUES (:userId, :mentorId, 'pending')`,
            { userId, mentorId }
        );
        res.status(201).json({ request_id: result.insertId, status: 'pending' });
    } catch (err) {
        if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'Mentor not found' });
        next(err);
    }
}

async function listMyRequests(req, res, next) {
    try {
        const { userId, role } = req.user;
        const column = role === 'mentor' ? 'mentor_id' : 'mentee_id';
        const otherColumn = role === 'mentor' ? 'mentee_id' : 'mentor_id';

        const [rows] = await pool.execute(
            `SELECT r.request_id, r.status, r.requested_at, u.user_id AS other_user_id, u.name AS other_name, u.department AS other_department
   FROM mentorship_requests r
   JOIN users u ON u.user_id = r.${otherColumn}
   WHERE r.${column} = :userId
   ORDER BY r.requested_at DESC`,
            { userId }
        );

        res.json(rows);
    } catch (err) { next(err); }
}

async function respondToRequest(req, res, next) {
    try {
        const { userId, role } = req.user;
        if (role !== 'mentor') return res.status(403).json({ error: 'Only mentors can respond to requests' });

        const { id } = req.params;
        const { decision } = req.body;
        if (!['accepted', 'declined'].includes(decision)) {
            return res.status(400).json({ error: "decision must be 'accepted' or 'declined'" });
        }

        const [[request]] = await pool.execute(
            `SELECT * FROM mentorship_requests WHERE request_id = :id AND mentor_id = :userId`,
            { id, userId }
        );
        if (!request) return res.status(404).json({ error: 'Request not found' });
        if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided' });

        await pool.execute(
            `UPDATE mentorship_requests SET status = :decision WHERE request_id = :id`,
            { decision, id }
        );
        res.json({ request_id: Number(id), status: decision });
    } catch (err) { next(err); }
}

async function withdrawRequest(req, res, next) {
  try {
    const { userId, role } = req.user;
    if (role !== 'mentee') return res.status(403).json({ error: 'Only mentees can withdraw a request' });

    const { id } = req.params;
    const [[request]] = await pool.execute(
      `SELECT * FROM mentorship_requests WHERE request_id = :id AND mentee_id = :userId`,
      { id, userId }
    );
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Only a pending request can be withdrawn' });

    await pool.execute(`DELETE FROM mentorship_requests WHERE request_id = :id`, { id });
    res.json({ success: true });
  } catch (err) { next(err); }
}

module.exports = { createRequest, listMyRequests, respondToRequest, withdrawRequest };