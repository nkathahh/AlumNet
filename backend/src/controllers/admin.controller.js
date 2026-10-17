const pool = require('../config/db');
const { validateEventInput } = require('./events.controller');

async function getStats(req, res, next) {
    try {
        const [[{ totalAlumni }]] = await pool.query(
            `SELECT COUNT(*) AS totalAlumni FROM users u
       WHERE EXISTS (SELECT 1 FROM mentees m WHERE m.user_id = u.user_id)
          OR EXISTS (SELECT 1 FROM mentors m WHERE m.user_id = u.user_id)`
        );
        const [[{ activeMentorships }]] = await pool.query(
            `SELECT COUNT(*) AS activeMentorships FROM mentorship_requests WHERE status = 'accepted'`
        );
        const [[{ pendingRequests }]] = await pool.query(
            `SELECT COUNT(*) AS pendingRequests FROM mentorship_requests WHERE status = 'pending'`
        );
        const [[{ flaggedAccounts }]] = await pool.query(
            `SELECT COUNT(*) AS flaggedAccounts FROM users WHERE status = 'suspended'`
        );
        res.json({ totalAlumni, activeMentorships, pendingRequests, flaggedAccounts });
    } catch (err) { next(err); }
}

async function listUsers(req, res, next) {
    try {
        const [rows] = await pool.query(`
      SELECT u.user_id, u.name, u.email, u.status, u.created_at, u.department,
        CASE
          WHEN me.user_id IS NOT NULL THEN 'mentee'
          WHEN mo.user_id IS NOT NULL THEN 'mentor'
          WHEN ad.user_id IS NOT NULL THEN 'admin'
        END AS role
      FROM users u
      LEFT JOIN mentees me ON me.user_id = u.user_id
      LEFT JOIN mentors mo ON mo.user_id = u.user_id
      LEFT JOIN admins ad ON ad.user_id = u.user_id
      ORDER BY u.created_at DESC
    `);
        res.json(rows);
    } catch (err) { next(err); }
}

async function toggleUserStatus(req, res, next) {
    try {
        const { id } = req.params;
        const [[user]] = await pool.execute('SELECT status FROM users WHERE user_id = :id', { id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const newStatus = user.status === 'active' ? 'suspended' : 'active';
        await pool.execute('UPDATE users SET status = :newStatus WHERE user_id = :id', { newStatus, id });

        await logAdminAction(req.user.userId, newStatus === 'suspended' ? 'suspend_user' : 'reactivate_user', 'users', id, `User ${id} set to ${newStatus}`);

        res.json({ user_id: Number(id), status: newStatus });
    } catch (err) { next(err); }
}

async function listEvents(req, res, next) {
    try {
        const [rows] = await pool.query('SELECT * FROM events ORDER BY event_date DESC');
        res.json(rows);
    } catch (err) { next(err); }
}

async function createEvent(req, res, next) {
  try {
    const error = validateEventInput(req.body);
    if (error) return res.status(400).json({ error });

    const { title, eventDate, description, mode, location, capacity } = req.body;
    const [result] = await pool.execute(
      `INSERT INTO events (title, event_date, description, mode, location, capacity, created_by, status)
       VALUES (:title, :eventDate, :description, :mode, :location, :capacity, :userId, 'approved')`,
      {
        title: title.trim(),
        eventDate,
        description: description || null,
        mode,
        location: location.trim(),
        capacity: capacity ? Number(capacity) : null,
        userId: req.user.userId
      }
    );

    await logAdminAction(req.user.userId, 'create_event', 'events', result.insertId, `Created event "${title.trim()}"`);

    res.status(201).json({ eventId: result.insertId });
  } catch (err) {
    next(err);
  }
}


async function listPendingEvents(req, res, next) {
  try {
    const [rows] = await pool.execute(
      `SELECT e.event_id, e.title, e.event_date, e.description, e.mode, e.location, e.capacity,
              u.name AS proposed_by_name
       FROM events e
       JOIN users u ON u.user_id = e.created_by
       WHERE e.status = 'pending'
       ORDER BY e.event_date ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function reviewEvent(req, res, next) {
  try {
    const { decision } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approved or rejected' });
    }
    const eventId = req.params.id;
    const [result] = await pool.execute(
      `UPDATE events SET status = :decision WHERE event_id = :eventId AND status = 'pending'`,
      { decision, eventId }
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Event not found or already reviewed' });
    }

    await logAdminAction(
      req.user.userId,
        `${decision}_event`,
      'events',
      eventId,
      `Event proposal ${decision}`
    );

    res.json({ message: `Event ${decision}` });
  } catch (err) {
    next(err);
  }
}

async function deleteEvent(req, res, next) {
    try {
        const { id } = req.params;
        await pool.execute('DELETE FROM events WHERE event_id = :id', { id });
        await logAdminAction(req.user.userId, 'delete_event', 'events', id, `Deleted event ${id}`);
        res.json({ success: true });
    } catch (err) { next(err); }
}

async function listPendingOpportunities(req, res, next) {
    try {
        const [rows] = await pool.query(`
      SELECT co.*, u.name AS posted_by_name
      FROM career_opportunities co JOIN users u ON u.user_id = co.posted_by
      WHERE co.approval_status = 'pending'
      ORDER BY co.opportunity_id DESC
    `);
        res.json(rows);
    } catch (err) { next(err); }
}

async function reviewOpportunity(req, res, next) {
    try {
        const { id } = req.params;
        const { decision, reviewNotes } = req.body;
        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
        }
        await pool.execute(
            'UPDATE career_opportunities SET approval_status = :decision WHERE opportunity_id = :id',
            { decision, id }
        );
        await pool.execute(
            `INSERT INTO content_approvals (admin_id, opportunity_id, status, review_notes)
       VALUES (:adminId, :id, :decision, :reviewNotes)`,
            { adminId: req.user.userId, id, decision, reviewNotes: reviewNotes || null }
        );
        await logAdminAction(req.user.userId, `${decision}_opportunity`, 'career_opportunities', id, `Opportunity ${id} ${decision}`);
        res.json({ opportunity_id: Number(id), status: decision });
    } catch (err) { next(err); }
}

async function listActivityLogs(req, res, next) {
    try {
        const [rows] = await pool.query(`
      SELECT l.*, u.name AS admin_name
      FROM admin_activity_logs l JOIN users u ON u.user_id = l.admin_id
      ORDER BY l.created_at DESC LIMIT 50
    `);
        res.json(rows);
    } catch (err) { next(err); }
}

async function logAdminAction(adminId, actionType, targetEntity, targetEntityId, description) {
    await pool.execute(
        `INSERT INTO admin_activity_logs (admin_id, action_type, target_entity, target_entity_id, description)
     VALUES (:adminId, :actionType, :targetEntity, :targetEntityId, :description)`,
        { adminId, actionType, targetEntity, targetEntityId, description }
    );
}

module.exports = {
  getStats, listUsers, toggleUserStatus,
  listEvents, createEvent, deleteEvent,
  listPendingEvents, reviewEvent,
  listPendingOpportunities, reviewOpportunity,
  listActivityLogs
};