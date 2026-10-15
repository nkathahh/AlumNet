const pool = require('../config/db');

// Upcoming events, with attendee count and whether the current user is registered
async function listEvents(req, res, next) {
  try {
    const { userId } = req.user;
    const [rows] = await pool.execute(
      `SELECT e.event_id, e.title, e.event_date, e.description,
              COUNT(r.registration_id) AS attendee_count,
              MAX(r.user_id = :userId) AS is_registered
       FROM events e
       LEFT JOIN event_registrations r ON r.event_id = e.event_id
       WHERE e.event_date >= NOW()
       GROUP BY e.event_id
       ORDER BY e.event_date ASC`,
      { userId }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function registerForEvent(req, res, next) {
  try {
    const { userId } = req.user;
    const eventId = req.params.id;

    const [[event]] = await pool.execute(
      'SELECT event_id, event_date FROM events WHERE event_id = :eventId',
      { eventId }
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (new Date(event.event_date) < new Date()) {
      return res.status(400).json({ error: 'This event has already taken place' });
    }

    await pool.execute(
      'INSERT INTO event_registrations (event_id, user_id) VALUES (:eventId, :userId)',
      { eventId, userId }
    );
    res.status(201).json({ message: 'Registered' });
  } catch (err) {
    // The unique key rejects a second registration for the same event
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'You are already registered for this event' });
    }
    next(err);
  }
}

async function cancelRegistration(req, res, next) {
  try {
    const { userId } = req.user;
    const eventId = req.params.id;
    const [result] = await pool.execute(
      'DELETE FROM event_registrations WHERE event_id = :eventId AND user_id = :userId',
      { eventId, userId }
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'You are not registered for this event' });
    }
    res.json({ message: 'Registration cancelled' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listEvents, registerForEvent, cancelRegistration };