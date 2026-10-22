const pool = require('../config/db');

// Shared by mentor proposals and admin-created events
function validateEventInput({ title, eventDate, mode, location, capacity }) {
  if (!title || !title.trim()) return 'Title is required';
  if (!eventDate || isNaN(new Date(eventDate))) return 'A valid date and time is required';
  if (new Date(eventDate) <= new Date()) return 'Event date must be in the future';
  if (!['in_person', 'virtual'].includes(mode)) return 'Format must be in person or virtual';
  if (!location || !location.trim()) {
    return mode === 'virtual' ? 'A meeting link is required' : 'A venue is required';
  }
  // Blocks javascript: and other unsafe links from being shown to attendees
  if (mode === 'virtual' && !/^https?:\/\//i.test(location.trim())) {
    return 'Meeting link must start with http:// or https://';
  }
  if (capacity !== undefined && capacity !== null && capacity !== '') {
    const n = Number(capacity);
    if (!Number.isInteger(n) || n < 1) return 'Capacity must be a whole number of at least 1';
  }
  return null;
}

// Approved, upcoming events with organiser, attendance and the user's registration state
async function listEvents(req, res, next) {
  try {
    const { userId } = req.user;
    const [rows] = await pool.execute(
      `SELECT e.event_id, e.title, e.event_date, e.description, e.location, e.mode, e.capacity,
              MAX(u.name) AS organiser_name,
              (MAX(a.user_id IS NOT NULL) = 1 OR e.created_by IS NULL) AS is_official,
              COUNT(r.registration_id) AS attendee_count,
              MAX(r.user_id = :userId) AS is_registered
       FROM events e
       LEFT JOIN users u ON u.user_id = e.created_by
       LEFT JOIN admins a ON a.user_id = e.created_by
       LEFT JOIN event_registrations r ON r.event_id = e.event_id
       WHERE e.status = 'approved' AND e.event_date >= NOW()
       GROUP BY e.event_id
       ORDER BY e.event_date ASC`,
      { userId }
    );

    const events = rows.map((r) => {
      const registered = Number(r.is_registered) === 1;
      return {
        ...r,
        is_registered: registered,
        is_official: Number(r.is_official) === 1,
        attendee_count: Number(r.attendee_count),
        // Virtual meeting links are only sent to people who have registered
        location: r.mode === 'virtual' && !registered ? null : r.location
      };
    });

    res.json(events);
  } catch (err) {
    next(err);
  }
}

async function registerForEvent(req, res, next) {
  try {
    const { userId } = req.user;
    const eventId = req.params.id;

    const [[event]] = await pool.execute(
      `SELECT e.event_id, e.event_date, e.status, e.capacity,
              (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.event_id) AS taken
       FROM events e WHERE e.event_id = :eventId`,
      { eventId }
    );
    if (!event || event.status !== 'approved') return res.status(404).json({ error: 'Event not found' });
    if (new Date(event.event_date) < new Date()) {
      return res.status(400).json({ error: 'This event has already taken place' });
    }
    if (event.capacity !== null && Number(event.taken) >= event.capacity) {
      return res.status(409).json({ error: 'This event is full' });
    }

    await pool.execute(
      'INSERT INTO event_registrations (event_id, user_id) VALUES (:eventId, :userId)',
      { eventId, userId }
    );
    res.status(201).json({ message: 'Registered' });
  } catch (err) {
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

// Alumni (mentors) propose community events; they wait for admin approval
async function proposeEvent(req, res, next) {
  try {
    const { userId, role } = req.user;
    if (role !== 'mentor') {
      return res.status(403).json({ error: 'Only alumni can propose community events' });
    }
    const error = validateEventInput(req.body);
    if (error) return res.status(400).json({ error });

    const { title, eventDate, description, mode, location, capacity } = req.body;
    const [result] = await pool.execute(
      `INSERT INTO events (title, event_date, description, mode, location, capacity, created_by, status)
       VALUES (:title, :eventDate, :description, :mode, :location, :capacity, :userId, 'pending')`,
      {
        title: title.trim(),
        eventDate,
        description: description || null,
        mode,
        location: location.trim(),
        capacity: capacity ? Number(capacity) : null,
        userId
      }
    );
    res.status(201).json({ eventId: result.insertId, message: 'Submitted for review' });
  } catch (err) {
    next(err);
  }
}

// A mentor's own proposals, so they can see pending, approved and rejected ones
async function listMyProposals(req, res, next) {
  try {
    const { userId } = req.user;
    const [rows] = await pool.execute(
      `SELECT event_id, title, event_date, status
       FROM events WHERE created_by = :userId
       ORDER BY event_date DESC`,
      { userId }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  validateEventInput,
  listEvents,
  registerForEvent,
  cancelRegistration,
  proposeEvent,
  listMyProposals
};