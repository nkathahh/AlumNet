const pool = require('../config/db');
const { scanPost } = require('../utils/scam');
const { chooseLane, finishSubmission } = require('../utils/moderation');

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
    const scan = scanPost({ title, description, location: mode === 'virtual' ? null : location, link: mode === 'virtual' ? location : null });
    const routed = await chooseLane('event', { userId, title, link: mode === 'virtual' ? location : null }, scan);
    const [result] = await pool.execute(
      `INSERT INTO events (title, event_date, description, mode, location, capacity, created_by, status, risk_level, risk_flags, submitted_at)
       VALUES (:title, :eventDate, :description, :mode, :location, :capacity, :userId, 'pending', :riskLevel, :riskFlags, NOW())`,
      {
        title: title.trim(),
        eventDate,
        description: description || null,
        mode,
        location: location.trim(),
        capacity: capacity ? Number(capacity) : null,
        userId,
        riskLevel: scan.level,
        riskFlags: JSON.stringify(scan.flags)
      }
    );
    const reply = await finishSubmission('event', result.insertId, routed, scan);
    res.status(201).json({ eventId: result.insertId, ...reply });
  } catch (err) {
    next(err);
  }
}

async function resubmitEvent(req, res, next) {
  try {
    const { userId } = req.user;
    const id = Number(req.params.id);
    const [[event]] = await pool.execute('SELECT status FROM events WHERE event_id = :id AND created_by = :userId', { id, userId });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status !== 'changes_requested') return res.status(409).json({ error: 'Only an event with changes requested can be edited' });
    const error = validateEventInput(req.body);
    if (error) return res.status(400).json({ error });

    const { title, eventDate, description, mode, location, capacity } = req.body;
    const scan = scanPost({ title, description, location: mode === 'virtual' ? null : location, link: mode === 'virtual' ? location : null });
    const routed = await chooseLane('event', { userId, title, link: mode === 'virtual' ? location : null, isResubmission: true, excludeId: id }, scan);
    await pool.execute(
      `UPDATE events SET title = :title, event_date = :eventDate, description = :description, mode = :mode, location = :location,
         capacity = :capacity, status = 'pending', risk_level = :riskLevel, risk_flags = :riskFlags, submitted_at = NOW(), reviewed_at = NULL
       WHERE event_id = :id`,
      {
        id, title: title.trim(), eventDate, description: description || null, mode, location: location.trim(),
        capacity: capacity ? Number(capacity) : null, riskLevel: scan.level, riskFlags: JSON.stringify(scan.flags)
      }
    );
    res.json({ eventId: id, ...(await finishSubmission('event', id, routed, scan)) });
  } catch (err) {
    next(err);
  }
}

// A mentor's own proposals, so they can see pending, approved and rejected ones
async function listMyProposals(req, res, next) {
  try {
    const { userId } = req.user;
    const [rows] = await pool.execute(
      `SELECT event_id, title, event_date, status, auto_approved, rejection_reason, review_note,
              description, mode, location, capacity
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
  resubmitEvent,
  listMyProposals
};