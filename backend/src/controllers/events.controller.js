const pool = require('../config/db');
const { scanPost } = require('../utils/scam');
const { chooseLane, finishSubmission } = require('../utils/moderation');
const { splitList } = require('../utils/fit');
const { annotateEvents } = require('../utils/recommend');
const { reviewEdit, eventChanges, listInWords } = require('../utils/liveEdit');
const { tellRegistrants } = require('../utils/eventNotice');

// Loaded lazily: admin.controller requires this file too
const logAdminAction = (...args) => require('./admin.controller').logAdminAction(...args);

// Topics (up to 6) and the departments an event is for (none means everyone)
async function cleanTargeting({ topics, audienceDepartments }) {
  const t = String(topics || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  if (t.length > 6) return { error: 'List up to 6 topics' };
  if (t.some((x) => x.length > 30)) return { error: 'Keep each topic under 30 characters' };
  const depts = Array.isArray(audienceDepartments) ? audienceDepartments.map((d) => String(d).trim()).filter(Boolean) : [];
  if (depts.length) {
    const [known] = await pool.query('SELECT DISTINCT department FROM staff_directory UNION SELECT DISTINCT department FROM users WHERE department IS NOT NULL');
    const allowed = new Set(known.map((k) => k.department));
    if (depts.some((d) => !allowed.has(d))) return { error: 'Choose departments from the list' };
  }
  return { topics: splitList(topics, 6, 30).join(', ') || null, audience: depts.length ? [...new Set(depts)].join(', ') : null };
}

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
      `SELECT e.event_id, e.title, e.event_date, e.edited_at, e.description, e.topics, e.audience_departments, e.location, e.mode, e.capacity,
              MAX(u.name) AS organiser_name,
              (MAX(a.user_id IS NOT NULL) = 1 OR e.created_by IS NULL) AS is_official,
              COUNT(r.registration_id) AS attendee_count,
              MAX(r.user_id = :userId) AS is_registered,
              (e.created_by = :userId) AS is_mine,
              (SELECT COUNT(*) FROM event_waitlist w WHERE w.event_id = e.event_id) AS waitlist_count,
              (SELECT COUNT(*) FROM event_waitlist w2 JOIN event_waitlist me ON me.event_id = w2.event_id AND me.user_id = :userId
                 WHERE w2.event_id = e.event_id AND w2.joined_at <= me.joined_at) AS waitlist_position
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
        is_mine: Number(r.is_mine) === 1,
        waitlist_count: Number(r.waitlist_count),
        waitlist_position: Number(r.waitlist_position) || null,
        is_official: Number(r.is_official) === 1,
        attendee_count: Number(r.attendee_count),
        // Virtual meeting links are only sent to people who have registered
        location: r.mode === 'virtual' && !registered && Number(r.is_mine) !== 1 ? null : r.location
      };
    });

    // Members see why an event might suit them; admins see the plain list
    if (req.user.role !== 'admin') return res.json(await annotateEvents(userId, events));
    res.json(events);
  } catch (err) {
    next(err);
  }
}

async function registerForEvent(req, res, next) {
  try {
    const { userId } = req.user;
    const eventId = req.params.id;

    // The seat count and the booking happen together, with the event row
    // locked, so two people cannot take the last seat at the same moment
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[event]] = await conn.execute(
        'SELECT event_id, event_date, status, capacity FROM events WHERE event_id = :eventId FOR UPDATE',
        { eventId }
      );
      if (!event || event.status !== 'approved') { await conn.rollback(); return res.status(404).json({ error: 'Event not found' }); }
      if (new Date(event.event_date) < new Date()) {
        await conn.rollback();
        return res.status(400).json({ error: 'This event has already taken place' });
      }
      const [[{ taken }]] = await conn.execute('SELECT COUNT(*) AS taken FROM event_registrations WHERE event_id = :eventId', { eventId });
      if (event.capacity !== null && Number(taken) >= event.capacity) {
        await conn.rollback();
        return res.status(409).json({ error: 'This event is full. You can join the waiting list.' });
      }
      await conn.execute('INSERT INTO event_registrations (event_id, user_id) VALUES (:eventId, :userId)', { eventId, userId });
      await conn.execute('DELETE FROM event_waitlist WHERE event_id = :eventId AND user_id = :userId', { eventId, userId });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
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
    await promoteFromWaitlist(eventId);
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
    const target = await cleanTargeting(req.body);
    if (target.error) return res.status(400).json({ error: target.error });
    const scan = scanPost({ title, description, location: mode === 'virtual' ? null : location, link: mode === 'virtual' ? location : null });
    const routed = await chooseLane('event', { userId, title, link: mode === 'virtual' ? location : null }, scan);
    const [result] = await pool.execute(
      `INSERT INTO events (title, event_date, description, topics, audience_departments, mode, location, capacity, created_by, status, risk_level, risk_flags, submitted_at)
       VALUES (:title, :eventDate, :description, :topics, :audience, :mode, :location, :capacity, :userId, 'pending', :riskLevel, :riskFlags, NOW())`,
      {
        title: title.trim(),
        eventDate,
        description: description || null,
        topics: target.topics,
        audience: target.audience,
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

/*
 * Editing an event. Before review the edit simply replaces the proposal.
 * Once it is live, plans can still change (new venue, new time): safe edits
 * stay live and registered people are told what changed; edits that change
 * the meeting link to an unknown site or trip the scam checks go back to the
 * alumni office first. Admins editing official events are trusted.
 */
async function saveEventEdit({ id, body, userId, isAdmin }) {
  const [[event]] = await pool.execute(
    `SELECT event_id, title, event_date, mode, location, capacity, status, created_by
     FROM events WHERE event_id = :id ${isAdmin ? '' : 'AND created_by = :userId'}`,
    { id, userId }
  );
  if (!event) return { status: 404, error: 'Event not found' };
  if (!['changes_requested', 'pending', 'approved'].includes(event.status)) {
    return { status: 409, error: event.status === 'cancelled' ? 'This event was cancelled' : 'This event can no longer be edited' };
  }
  if (event.status === 'approved' && new Date(event.event_date) < new Date()) return { status: 409, error: 'This event has already taken place' };
  const error = validateEventInput(body);
  if (error) return { status: 400, error };

  const { title, eventDate, description, mode, location, capacity } = body;
  const target = await cleanTargeting(body);
  if (target.error) return { status: 400, error: target.error };

  const [[{ taken }]] = await pool.execute('SELECT COUNT(*) AS taken FROM event_registrations WHERE event_id = :id', { id });
  if (capacity && Number(capacity) < Number(taken)) {
    return { status: 400, error: `${taken} people are already registered, so capacity cannot be lower than ${taken}` };
  }

  const fields = {
    id, title: title.trim(), eventDate, description: description || null, topics: target.topics, audience: target.audience,
    mode, location: location.trim(), capacity: capacity ? Number(capacity) : null
  };
  // A new date means a new reminder (this runs before event_date is changed)
  const setFields = `reminder_sent_at = IF(event_date <> :eventDate, NULL, reminder_sent_at), title = :title, event_date = :eventDate, description = :description, topics = :topics,
         audience_departments = :audience, mode = :mode, location = :location, capacity = :capacity`;
  const link = (m, l) => (m === 'virtual' ? l : null);
  const scan = scanPost({ title, description, location: mode === 'virtual' ? null : location, link: link(mode, location) });

  // Not live yet: the edit replaces the proposal and goes through the checks again
  if (event.status !== 'approved') {
    const resubmitting = event.status === 'changes_requested';
    const routed = await chooseLane('event', { userId, title, link: link(mode, location), isResubmission: resubmitting, excludeId: id }, scan);
    await pool.execute(
      `UPDATE events SET ${setFields}, status = 'pending', risk_level = :riskLevel, risk_flags = :riskFlags,
         submitted_at = IF(:resubmitting, NOW(), submitted_at), reviewed_at = NULL WHERE event_id = :id`,
      { ...fields, resubmitting: resubmitting ? 1 : 0, riskLevel: scan.level, riskFlags: JSON.stringify(scan.flags) }
    );
    return { status: 200, body: { eventId: id, ...(await finishSubmission('event', id, routed, scan)) } };
  }

  const changes = eventChanges(event, { event_date: eventDate, mode, location });
  const summary = changes.length ? `"${title.trim()}" has changed: please check ${listInWords(changes)}.` : null;
  const review = isAdmin
    ? { stayLive: true }
    : await reviewEdit('event', { userId, id, title, oldLink: link(event.mode, event.location), newLink: link(mode, location) }, scan);

  if (review.stayLive) {
    await pool.execute(
      `UPDATE events SET ${setFields}, risk_level = :riskLevel, risk_flags = :riskFlags, edited_at = NOW() WHERE event_id = :id`,
      { ...fields, riskLevel: scan.level, riskFlags: JSON.stringify(scan.flags) }
    );
    await promoteFromWaitlist(id);
    const told = summary
      ? await tellRegistrants({ eventId: id, ownerId: event.created_by, type: 'event_changed', message: summary, link: `events.html?open=${id}`, subject: `Change to ${title.trim()}` })
      : 0;
    if (!isAdmin) {
      await logAdminAction(null, 'live_edit', 'events', id,
        `Live event "${title.trim()}" was edited by its organiser${changes.length ? ` (${listInWords(changes)})` : ''} and stayed live after the checks`, title.trim());
    }
    return {
      status: 200,
      body: {
        eventId: id, published: true, needsCloserReview: false, warnings: [],
        message: told ? `Saved. ${told} registered ${told === 1 ? 'person was' : 'people were'} told what changed.` : 'Saved. Your event is updated.'
      }
    };
  }

  // Back to the alumni office; registered people keep their place and are told
  await pool.execute(
    `UPDATE events SET ${setFields}, status = 'pending', risk_level = :riskLevel, risk_flags = :riskFlags,
       submitted_at = NOW(), reviewed_at = NULL, edited_at = NOW(), change_summary = :summary WHERE event_id = :id`,
    { ...fields, riskLevel: scan.level, riskFlags: JSON.stringify(scan.flags), summary }
  );
  await tellRegistrants({
    eventId: id, ownerId: event.created_by, type: 'event_changed', link: 'events.html', subject: `${title.trim()} is being checked`,
    message: `"${title.trim()}" was changed by the organiser and is being checked by the alumni office. Your place is kept.`
  });
  const reply = await finishSubmission('event', id, review.routed, scan);
  return { status: 200, body: { eventId: id, ...reply, message: reply.needsCloserReview ? reply.message : 'Saved. Because of what changed, the alumni office will check it before it is live again.' } };
}

/*
 * Waiting list. Places are given in the order people joined. Promotion runs
 * with the event row locked, so a freed place is never given out twice.
 */
const LAST_MINUTE_HOURS = 24;
async function promoteFromWaitlist(eventId) {
  const conn = await pool.getConnection();
  let promoted = [];
  let title = '';
  let lastMinute = false;
  let lastMinuteIds = [];
  try {
    await conn.beginTransaction();
    const [[event]] = await conn.execute('SELECT title, capacity, status, event_date FROM events WHERE event_id = :eventId FOR UPDATE', { eventId });
    if (!event || event.status !== 'approved' || new Date(event.event_date) < new Date()) { await conn.rollback(); return []; }
    title = event.title;
    const [[{ taken }]] = await conn.execute('SELECT COUNT(*) AS taken FROM event_registrations WHERE event_id = :eventId', { eventId });
    const free = event.capacity === null ? 1000 : event.capacity - Number(taken);
    // Less than a day to go: someone given a place now may not see the message in
    // time and the seat goes empty. Everyone waiting is told instead; first to register gets it.
    lastMinute = new Date(event.event_date) - Date.now() < LAST_MINUTE_HOURS * 3600 * 1000;
    if (free > 0 && lastMinute) {
      const [waiting] = await conn.execute('SELECT user_id FROM event_waitlist WHERE event_id = :eventId', { eventId });
      lastMinuteIds = waiting.map((w) => w.user_id);
    } else if (free > 0) {
      const [next] = await conn.query('SELECT user_id FROM event_waitlist WHERE event_id = ? ORDER BY joined_at LIMIT ?', [eventId, free]);
      for (const n of next) {
        await conn.execute('INSERT IGNORE INTO event_registrations (event_id, user_id) VALUES (:eventId, :u)', { eventId, u: n.user_id });
        await conn.execute('DELETE FROM event_waitlist WHERE event_id = :eventId AND user_id = :u', { eventId, u: n.user_id });
      }
      promoted = next.map((n) => n.user_id);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  if (lastMinuteIds.length) {
    // Time matters here, so it goes by email as well as in the app
    const { sendMail, emailLayout } = require('../utils/mailer');
    const { esc } = require('../utils/eventNotice');
    const message = `A place has opened at "${title}", which starts within a day. Register now if you can still go: the first person to register gets it.`;
    const url = `${process.env.APP_URL || 'http://localhost:4000'}/events.html?open=${eventId}`;
    const [people] = await pool.query('SELECT user_id, email FROM users WHERE user_id IN (?)', [lastMinuteIds]);
    for (const p of people) {
      await require('../utils/notify').createNotification(p.user_id, 'event_place_free', message, `events.html?open=${eventId}`);
      sendMail({
        to: p.email, subject: `A place is free: ${title}`, text: `${message}\n\nRegister here: ${url}`,
        html: emailLayout(esc(`A place is free: ${title}`), `<p>${esc(message)}</p><p style="margin:24px 0;"><a href="${esc(url)}" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Register now</a></p>`)
      }).catch(() => null);
    }
  }
  if (promoted.length) {
    const { sendMail, emailLayout } = require('../utils/mailer');
    const { esc } = require('../utils/eventNotice');
    const message = `A place opened up: you are now registered for "${title}". If you can no longer go, cancel so the next person gets it.`;
    const [people] = await pool.query('SELECT user_id, email, name FROM users WHERE user_id IN (?)', [promoted]);
    for (const p of people) {
      await require('../utils/notify').createNotification(p.user_id, 'event_waitlist_place', message, `events.html?open=${eventId}`);
      sendMail({
        to: p.email, subject: `You have a place: ${title}`, text: message,
        html: emailLayout(esc(`You have a place: ${title}`), `<p>${esc(message)}</p><p style="margin:24px 0;"><a href="${esc((process.env.APP_URL || 'http://localhost:4000') + '/events.html?open=' + eventId)}" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">See the event</a></p>`)
      }).catch(() => null);
    }
  }
  return promoted;
}

async function joinWaitlist(req, res, next) {
  try {
    const eventId = Number(req.params.id);
    const { userId } = req.user;
    const [[event]] = await pool.execute(
      `SELECT e.status, e.event_date, e.capacity, e.created_by,
              (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.event_id) AS taken,
              (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.event_id AND r.user_id = :userId) AS mine
       FROM events e WHERE e.event_id = :eventId`, { eventId, userId }
    );
    if (!event || event.status !== 'approved') return res.status(404).json({ error: 'Event not found' });
    if (new Date(event.event_date) < new Date()) return res.status(400).json({ error: 'This event has already taken place' });
    if (Number(event.mine)) return res.status(409).json({ error: 'You are already registered' });
    if (event.capacity === null || Number(event.taken) < event.capacity) return res.status(409).json({ error: 'There is a free place, so you can register now' });
    await pool.execute('INSERT IGNORE INTO event_waitlist (event_id, user_id) VALUES (:eventId, :userId)', { eventId, userId });
    const [[{ position }]] = await pool.execute(
      `SELECT COUNT(*) AS position FROM event_waitlist w JOIN event_waitlist me ON me.event_id = w.event_id AND me.user_id = :userId
       WHERE w.event_id = :eventId AND w.joined_at <= me.joined_at`, { eventId, userId }
    );
    res.status(201).json({ message: `You are number ${position} on the waiting list. If a place opens, you get it and we tell you.`, position: Number(position) });
  } catch (err) {
    next(err);
  }
}

async function leaveWaitlist(req, res, next) {
  try {
    await pool.execute('DELETE FROM event_waitlist WHERE event_id = :eventId AND user_id = :userId', { eventId: Number(req.params.id), userId: req.user.userId });
    res.json({ message: 'You have left the waiting list' });
  } catch (err) {
    next(err);
  }
}

async function updateEvent(req, res, next) {
  try {
    const r = await saveEventEdit({ id: Number(req.params.id), body: req.body, userId: req.user.userId, isAdmin: false });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r.body);
  } catch (err) {
    next(err);
  }
}

// The organiser calls off their event; registered people are told and the record is kept
async function cancelEvent(req, res, next) {
  try {
    const id = Number(req.params.id);
    const isAdmin = req.user.role === 'admin';
    const [[event]] = await pool.execute(
      `SELECT event_id, title, status, created_by FROM events WHERE event_id = :id ${isAdmin ? '' : 'AND created_by = :userId'}`,
      { id, userId: req.user.userId }
    );
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!['pending', 'approved', 'changes_requested'].includes(event.status)) return res.status(409).json({ error: 'This event cannot be cancelled' });
    const reason = String((req.body || {}).reason || '').trim().slice(0, 255) || null;
    await pool.execute(`UPDATE events SET status = 'cancelled', cancel_reason = :reason, edited_at = NOW() WHERE event_id = :id`, { id, reason });
    const told = event.status === 'approved'
      ? await tellRegistrants({
        eventId: id, ownerId: event.created_by, type: 'event_cancelled', link: 'events.html', subject: `Cancelled: ${event.title}`,
        message: `"${event.title}" has been cancelled by ${isAdmin ? 'the alumni office' : 'the organiser'}.${reason ? ' Reason: ' + reason : ''}`
      })
      : 0;
    const [waiting] = await pool.execute('SELECT user_id FROM event_waitlist WHERE event_id = :id', { id });
    if (waiting.length) {
      await require('../utils/notify').notifyMany(waiting.map((w) => w.user_id), 'event_cancelled', `"${event.title}" has been cancelled, so the waiting list is closed.`, 'events.html');
      await pool.execute('DELETE FROM event_waitlist WHERE event_id = :id', { id });
    }
    await logAdminAction(isAdmin ? req.user.userId : null, 'cancel_event', 'events', id,
      `Event "${event.title}" was cancelled by ${isAdmin ? 'the alumni office' : 'its organiser'}`, event.title);
    res.json({ message: told ? `Event cancelled. ${told} registered ${told === 1 ? 'person was' : 'people were'} told.` : 'Event cancelled.' });
  } catch (err) {
    next(err);
  }
}

// A mentor's own proposals, so they can see pending, approved and rejected ones
async function listMyProposals(req, res, next) {
  try {
    const { userId } = req.user;
    const [rows] = await pool.execute(
      `SELECT e.event_id, e.title, e.event_date, e.status, e.rejection_reason, e.review_note, e.edited_at, e.cancel_reason,
              e.description, e.topics, e.audience_departments, e.mode, e.location, e.capacity,
              (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.event_id) AS attendee_count
       FROM events e WHERE e.created_by = :userId
       ORDER BY e.event_date DESC`,
      { userId }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// Departments for the "who is this event for" choice
async function listDepartments(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT department FROM staff_directory WHERE department IS NOT NULL
       UNION SELECT department FROM users WHERE department IS NOT NULL ORDER BY department`
    );
    res.json(rows.map((r) => r.department).filter(Boolean));
  } catch (err) { next(err); }
}

module.exports = {
  listDepartments,
  cleanTargeting,
  validateEventInput,
  listEvents,
  registerForEvent,
  cancelRegistration,
  proposeEvent,
  saveEventEdit,
  promoteFromWaitlist,
  joinWaitlist,
  leaveWaitlist,
  updateEvent,
  cancelEvent,
  listMyProposals
};