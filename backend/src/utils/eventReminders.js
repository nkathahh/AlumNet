/*
 * A reminder the day before an event, in the app and by email, to everyone
 * registered. Sent once per event (reminder_sent_at), checked every hour, for
 * events starting in the next 18 to 30 hours so an hourly check never misses one.
 */
const pool = require('../config/db');
const { tellRegistrants } = require('./eventNotice');

async function sendEventReminders() {
  const [events] = await pool.query(
    `SELECT event_id, title, event_date, mode, location, created_by FROM events
     WHERE status = 'approved' AND reminder_sent_at IS NULL
       AND event_date BETWEEN DATE_ADD(NOW(), INTERVAL 18 HOUR) AND DATE_ADD(NOW(), INTERVAL 30 HOUR)`
  );
  let sent = 0;
  for (const e of events) {
    // Claim it first, so two copies of the server cannot both send it
    const [claim] = await pool.execute('UPDATE events SET reminder_sent_at = NOW() WHERE event_id = :id AND reminder_sent_at IS NULL', { id: e.event_id });
    if (!claim.affectedRows) continue;
    const when = new Date(e.event_date).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'long', hour: '2-digit', minute: '2-digit' });
    const where = e.mode === 'virtual' ? 'online (the link is on the event page)' : `at ${e.location}`;
    sent += await tellRegistrants({
      eventId: e.event_id, ownerId: e.created_by, type: 'event_reminder', link: `events.html?open=${e.event_id}`,
      subject: `Tomorrow: ${e.title}`,
      message: `Reminder: "${e.title}" is ${when} Nairobi time, ${where}. If you can no longer go, cancel so someone on the waiting list gets your place.`
    });
  }
  return sent;
}

module.exports = { sendEventReminders };
