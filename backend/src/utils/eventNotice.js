/*
 * Telling people registered for an event that it changed or was cancelled.
 * This goes to the app and by email, because a venue change the night
 * before is no use if it only waits in the app until someone logs in.
 */
const pool = require('../config/db');
const { notifyMany } = require('./notify');
const { sendMail, emailLayout } = require('./mailer');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function registrantsOf(eventId, ownerId) {
  const [rows] = await pool.execute(
    `SELECT u.user_id, u.email, u.name FROM event_registrations r JOIN users u ON u.user_id = r.user_id
     WHERE r.event_id = :eventId AND r.user_id != :owner AND u.status = 'active'`,
    { eventId, owner: ownerId || 0 }
  );
  return rows;
}

// Returns how many people were told
async function tellRegistrants({ eventId, ownerId, type, message, link, subject }) {
  const people = await registrantsOf(eventId, ownerId);
  if (!people.length) return 0;
  await notifyMany(people.map((p) => p.user_id), type, message, link);
  const url = `${process.env.APP_URL || 'http://localhost:4000'}/${link}`;
  // Email failures never undo the change; the in-app notice is already saved
  Promise.all(people.map((p) => sendMail({
    to: p.email,
    subject,
    text: `Hi ${p.name.split(' ')[0]},\n\n${message}\n\nSee the details: ${url}`,
    html: emailLayout(esc(subject), `<p>Hi ${esc(p.name.split(' ')[0])},</p><p>${esc(message)}</p>
      <p style="margin:24px 0;"><a href="${esc(url)}" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">See the event</a></p>`)
  }).catch((err) => console.error('Event email not sent:', err.message)))).catch(() => null);
  return people.length;
}

module.exports = { tellRegistrants, registrantsOf, esc };
