/*
 * Targeted alerts: when an opportunity or event goes live, only the members
 * it fits well are told, and nobody gets more than a few alerts a week. This
 * is the opposite of a group chat where everyone gets everything.
 */
const pool = require('../config/db');
const { mlPost } = require('./ml');
const { bandFor, skillCoverage, splitList, topicOverlap } = require('./fit');
const { opportunityText, eventText } = require('./recommend');
const { createNotification } = require('./notify');

const ALERT = {
  perWeek: 3,          // most alerts one member gets in 7 days
  perItem: 200,        // most members told about one post
  strongScore: 72      // same as the "Strong fit" band
};

async function candidates(kind, item) {
  const audience = kind === 'event' ? splitList(item.audience_departments, 20, 100) : [];
  const prefColumn = kind === 'opportunity' ? 'alert_opportunities' : 'alert_events';
  // Opportunities are for current staff (mentees); events are for everyone
  const roleSql = kind === 'opportunity'
    ? `AND EXISTS (SELECT 1 FROM mentees me WHERE me.user_id = u.user_id)
       AND (sd.staff_number IS NULL OR sd.employment_status = 'active')`
    : 'AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.user_id = u.user_id)';
  const [rows] = await pool.query(
    `SELECT u.user_id, u.department, p.skills, p.career_interests, p.headline,
            (SELECT COUNT(*) FROM alerts_sent s WHERE s.user_id = u.user_id AND s.sent_at > DATE_SUB(NOW(), INTERVAL 7 DAY)) AS recent
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.user_id
     LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
     WHERE u.status = 'active' AND u.${prefColumn} = 1 AND u.user_id != ?
       ${roleSql}
       AND NOT EXISTS (SELECT 1 FROM alerts_sent s WHERE s.user_id = u.user_id AND s.item_type = ? AND s.item_id = ?)`,
    [item.owner_id || 0, kind, item.id]
  );
  return rows.filter((r) => Number(r.recent) < ALERT.perWeek && (!audience.length || audience.includes(r.department)));
}

async function sendAlertsFor(kind, id) {
  const [[item]] = kind === 'opportunity'
    ? await pool.execute(
      `SELECT opportunity_id AS id, posted_by AS owner_id, title, company, industry, required_skills, description
       FROM career_opportunities WHERE opportunity_id = :id AND approval_status = 'approved'`, { id })
    : await pool.execute(
      `SELECT event_id AS id, created_by AS owner_id, title, topics, audience_departments, description, event_date
       FROM events WHERE event_id = :id AND status = 'approved' AND event_date > NOW()`, { id });
  if (!item) return 0;

  const people = await candidates(kind, item);
  if (!people.length) return 0;

  let scores = null;
  try {
    const { data } = await mlPost('/score-users', {
      key: `${kind === 'opportunity' ? 'opp' : 'event'}:${id}`,
      text: kind === 'opportunity' ? opportunityText(item) : eventText(item),
      user_ids: people.map((p) => p.user_id)
    }, 20000);
    scores = new Map(data.map((r) => [r.user_id, r.score]));
  } catch {
    scores = null; // fall back to skills and topics only
  }

  const picked = [];
  for (const p of people) {
    const score = scores ? scores.get(p.user_id) : null;
    const strong = score !== null && score !== undefined && score >= ALERT.strongScore;
    let reason = null;
    if (kind === 'opportunity') {
      const cov = skillCoverage(item.required_skills, p.skills);
      if (cov.required.length && cov.have.length >= 2 && cov.ratio >= 0.6) reason = `You have ${cov.have.length} of ${cov.required.length} skills it asks for.`;
      else if (strong) reason = 'It matches your profile closely.';
    } else {
      const shared = topicOverlap(item.topics, [p.career_interests, p.skills, p.headline].filter(Boolean).join(' '));
      if (shared.length) reason = `It covers ${shared.slice(0, 2).join(' and ').toLowerCase()}, which you are interested in.`;
      else if (strong) reason = 'It matches your profile closely.';
    }
    if (reason) picked.push({ userId: p.user_id, reason, score: score ?? 0 });
  }
  picked.sort((a, b) => b.score - a.score);

  for (const p of picked.slice(0, ALERT.perItem)) {
    const [res] = await pool.execute(
      'INSERT IGNORE INTO alerts_sent (user_id, item_type, item_id) VALUES (:u, :t, :i)',
      { u: p.userId, t: kind, i: id }
    );
    if (!res.affectedRows) continue;
    const what = kind === 'opportunity'
      ? `New opportunity that fits you: ${item.title}${item.company ? ' at ' + item.company : ''}.`
      : `An event you may like: ${item.title}.`;
    await createNotification(
      p.userId, `${kind}_alert`, `${what} ${p.reason}`,
      kind === 'opportunity' ? `opportunities.html?open=${id}` : `events.html?open=${id}`
    );
  }
  return picked.length;
}

// Alerts never hold up the action that triggered them
function queueAlerts(kind, id) {
  setImmediate(() => {
    sendAlertsFor(kind, id).catch((err) => console.error('Alerts skipped:', err.message));
  });
}

module.exports = { ALERT, sendAlertsFor, queueAlerts };
