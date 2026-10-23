/*
 * Live posts are checked again, not only when they are submitted. A website,
 * email or link can be blocked after a post using it was approved (another
 * post with it turned out to be a scam), and the scam rules improve over
 * time. A live post that now fails is taken off the list and held for an
 * admin. Nothing is deleted, and an admin can approve it again.
 *
 * Runs with the twice-daily clean-up, and straight away after an admin
 * rejects a post as a scam.
 */
const pool = require('../config/db');
const { scanPost } = require('./scam');
const { indicatorsFor, normaliseLink } = require('./moderation');
const { createNotification, notifyMany } = require('./notify');

// Only indicators blocked after the post was last approved count: an admin
// who approved it knowing about them has already decided
async function blockedReason(link, reviewedAt) {
  if (!link) return null;
  const { email, domain } = indicatorsFor(link);
  const [rows] = await pool.execute(
    `SELECT kind, value FROM blocked_indicators
     WHERE ((kind = 'domain' AND value = :domain) OR (kind = 'email' AND value = :email) OR (kind = 'link' AND value = :link))
       AND (:reviewedAt IS NULL OR created_at >= :reviewedAt) LIMIT 1`,
    { domain: domain || '', email: email || '', link: normaliseLink(link), reviewedAt: reviewedAt || null }
  );
  return rows[0] ? `Now uses ${{ email: 'an email', link: 'a link', domain: 'a website' }[rows[0].kind]} blocked as a scam (${rows[0].value})` : null;
}

async function recheckLivePosts() {
  const held = [];
  const [opps] = await pool.query(
    `SELECT opportunity_id AS id, posted_by AS owner, title, company, description, location, apply_link AS link, risk_level, reviewed_at
     FROM career_opportunities WHERE approval_status = 'approved' AND closed_at IS NULL
       AND (closing_date IS NULL OR closing_date >= CURDATE())`
  );
  const [events] = await pool.query(
    `SELECT event_id AS id, created_by AS owner, title, description, location, mode, risk_level, reviewed_at
     FROM events WHERE status = 'approved' AND event_date > NOW() AND created_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.user_id = events.created_by)`
  );
  const items = [
    ...opps.map((o) => ({ kind: 'opportunity', ...o, scan: scanPost({ title: o.title, description: o.description, company: o.company, location: o.location, link: o.link }) })),
    ...events.map((e) => {
      const link = e.mode === 'virtual' ? e.location : null;
      return { kind: 'event', ...e, link, scan: scanPost({ title: e.title, description: e.description, location: link ? null : e.location, link }) };
    })
  ];
  for (const item of items) {
    const reasons = [];
    const blocked = await blockedReason(item.link, item.reviewed_at);
    if (blocked) reasons.push(blocked);
    // Newer rules now see high risk where the approved version did not
    if (item.scan.level === 'high' && item.risk_level !== 'high') reasons.push('Automatic re-check of a live post: the updated scam checks now see high risk');
    if (!reasons.length) continue;
    const t = item.kind === 'opportunity'
      ? { table: 'career_opportunities', id: 'opportunity_id', status: 'approval_status' }
      : { table: 'events', id: 'event_id', status: 'status' };
    const [r] = await pool.execute(
      `UPDATE ${t.table} SET ${t.status} = 'pending', moderation_lane = 'hold', lane_reasons = :reasons,
         risk_level = :level, risk_flags = :flags, reviewed_at = NULL
       WHERE ${t.id} = :id AND ${t.status} = 'approved'`,
      { reasons: JSON.stringify(['Taken off the list by the automatic re-check', ...reasons]), level: item.scan.level, flags: JSON.stringify(item.scan.flags), id: item.id }
    );
    if (!r.affectedRows) continue;
    held.push(item);
    await require('../controllers/admin.controller').logAdminAction(null, `auto_hold_${item.kind}`, t.table, item.id,
      `Took live ${item.kind} "${item.title}" off the list for review. ${reasons.join('; ')}`, item.title);
    // The poster is told only that it is being checked, not which rule caught it
    if (item.owner) {
      await createNotification(item.owner, `${item.kind}_pending`, `Your ${item.kind} "${item.title}" is being checked again by the alumni office and is hidden until then.`,
        item.kind === 'opportunity' ? 'opportunities.html' : 'events.html');
    }
  }
  if (held.length) {
    const [admins] = await pool.query("SELECT a.user_id FROM admins a JOIN users u ON u.user_id = a.user_id WHERE u.status = 'active'");
    await notifyMany(admins.map((a) => a.user_id), 'moderation_held',
      `${held.length} live post${held.length === 1 ? ' was' : 's were'} taken off the list by the automatic re-check and ${held.length === 1 ? 'needs' : 'need'} a look.`, 'admin.html#moderation');
  }
  return held.length;
}

module.exports = { recheckLivePosts };
