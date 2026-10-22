const pool = require('../config/db');
const { createNotification } = require('../utils/notify');
const { endOpenMentorships } = require('../utils/hr');

const REASONS = {
  fake_profile: 'Fake profile or impersonation',
  asked_for_money: 'Asked for money or personal details',
  harassment: 'Harassment or inappropriate behaviour',
  spam: 'Spam',
  misleading: 'Misleading or false information',
  other: 'Something else'
};
// After this many different people report a post, it is hidden until an admin reviews it
const AUTO_HIDE_AFTER = 3;

async function targetExists(type, id) {
  const sql = {
    user: "SELECT user_id AS id FROM users WHERE user_id = :id AND status != 'deleted'",
    opportunity: 'SELECT opportunity_id AS id FROM career_opportunities WHERE opportunity_id = :id',
    event: 'SELECT event_id AS id FROM events WHERE event_id = :id'
  }[type];
  const [[row]] = await pool.execute(sql, { id });
  return Boolean(row);
}

async function ownerOf(type, id) {
  if (type === 'user') return Number(id);
  const sql = type === 'opportunity'
    ? 'SELECT posted_by AS owner FROM career_opportunities WHERE opportunity_id = :id'
    : 'SELECT created_by AS owner FROM events WHERE event_id = :id';
  const [[row]] = await pool.execute(sql, { id });
  return row ? row.owner : null;
}

async function createReport(req, res, next) {
  try {
    const { userId } = req.user;
    const { targetType, reason } = req.body;
    const targetId = Number(req.body.targetId);
    const details = String(req.body.details || '').trim().slice(0, 500);

    if (!['user', 'opportunity', 'event'].includes(targetType) || !Number.isInteger(targetId)) {
      return res.status(400).json({ error: 'Choose what you are reporting' });
    }
    if (!REASONS[reason]) return res.status(400).json({ error: 'Choose a reason' });
    if (reason === 'other' && details.length < 10) {
      return res.status(400).json({ error: 'Tell us a little about what happened' });
    }
    if (!(await targetExists(targetType, targetId))) return res.status(404).json({ error: 'Not found' });
    if ((await ownerOf(targetType, targetId)) === userId) {
      return res.status(400).json({ error: 'You cannot report yourself or your own post' });
    }

    const [[already]] = await pool.execute(
      `SELECT report_id FROM reports WHERE reporter_id = :userId AND target_type = :targetType
       AND target_id = :targetId AND status = 'open'`,
      { userId, targetType, targetId }
    );
    if (already) return res.json({ message: 'You have already reported this. The alumni office is looking into it.' });

    await pool.execute(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, details)
       VALUES (:userId, :targetType, :targetId, :reason, :details)`,
      { userId, targetType, targetId, reason, details: details || null }
    );

    // Several separate reports on a post: take it down until an admin has looked
    if (targetType !== 'user') {
      const [[{ reporters }]] = await pool.execute(
        `SELECT COUNT(DISTINCT reporter_id) AS reporters FROM reports
         WHERE target_type = :targetType AND target_id = :targetId AND status = 'open'`,
        { targetType, targetId }
      );
      if (reporters >= AUTO_HIDE_AFTER) {
        if (targetType === 'opportunity') {
          await pool.execute(
            `UPDATE career_opportunities SET approval_status = 'pending', moderation_lane = 'hold',
               lane_reasons = '["Hidden after reports from 3 members"]' WHERE opportunity_id = :targetId AND approval_status = 'approved'`,
            { targetId }
          );
        } else {
          await pool.execute(
            `UPDATE events SET status = 'pending', moderation_lane = 'hold',
               lane_reasons = '["Hidden after reports from 3 members"]' WHERE event_id = :targetId AND status = 'approved' AND created_by IS NOT NULL`,
            { targetId }
          );
        }
      }
    }

    res.status(201).json({ message: 'Thank you. The alumni office will review this. The person is not told who reported them.' });
  } catch (err) { next(err); }
}

/*
 * Files a report from "Automatic check" when the scam check finds something
 * serious in a message or profile. One open automatic report per target, so
 * saving a profile twice does not pile up reports.
 */
async function fileAutomaticReport(targetType, targetId, scan, where) {
  if (!scan || scan.level !== 'high') return;
  try {
    const [[open]] = await pool.execute(
      `SELECT report_id FROM reports WHERE source = 'automatic' AND target_type = :targetType
       AND target_id = :targetId AND status = 'open'`,
      { targetType, targetId }
    );
    const asksMoney = scan.flags.some((f) => /pay|ID, passport/i.test(f.label));
    const details = `Found in ${where}: ${scan.flags.map((f) => f.label).join('; ')}`.slice(0, 500);
    if (open) {
      await pool.execute('UPDATE reports SET details = :details WHERE report_id = :id', { details, id: open.report_id });
      return;
    }
    await pool.execute(
      `INSERT INTO reports (reporter_id, source, target_type, target_id, reason, details)
       VALUES (NULL, 'automatic', :targetType, :targetId, :reason, :details)`,
      { targetType, targetId, reason: asksMoney ? 'asked_for_money' : 'other', details }
    );
  } catch (err) {
    console.error('Automatic report failed:', err.message);
  }
}

async function listBlocks(req, res, next) {
  try {
    const [rows] = await pool.execute(
      `SELECT b.blocked_id AS user_id, u.name, u.department, b.created_at
       FROM user_blocks b JOIN users u ON u.user_id = b.blocked_id
       WHERE b.blocker_id = :userId ORDER BY b.created_at DESC`,
      { userId: req.user.userId }
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// Blocking stops requests between the two people and closes any open ones
async function blockUser(req, res, next) {
  try {
    const { userId } = req.user;
    const blockedId = Number(req.params.id);
    if (!Number.isInteger(blockedId) || blockedId === userId) return res.status(400).json({ error: 'You cannot block this account' });
    const [[target]] = await pool.execute(
      `SELECT u.user_id, (SELECT 1 FROM admins a WHERE a.user_id = u.user_id) AS is_admin
       FROM users u WHERE u.user_id = :blockedId AND u.status != 'deleted'`,
      { blockedId }
    );
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.is_admin) return res.status(400).json({ error: 'The alumni office cannot be blocked' });

    await pool.execute('INSERT IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (:userId, :blockedId)', { userId, blockedId });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE mentorship_requests SET status = 'declined', responded_at = NOW()
         WHERE status = 'pending' AND ((mentor_id = :a AND mentee_id = :b) OR (mentor_id = :b AND mentee_id = :a))`,
        { a: userId, b: blockedId }
      );
      await conn.execute(
        `UPDATE mentorship_requests SET status = 'ended', ended_by = :a, ended_at = NOW()
         WHERE status = 'accepted' AND ((mentor_id = :a AND mentee_id = :b) OR (mentor_id = :b AND mentee_id = :a))`,
        { a: userId, b: blockedId }
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ blocked: true });
  } catch (err) { next(err); }
}

async function unblockUser(req, res, next) {
  try {
    await pool.execute('DELETE FROM user_blocks WHERE blocker_id = :userId AND blocked_id = :id', { userId: req.user.userId, id: req.params.id });
    res.json({ blocked: false });
  } catch (err) { next(err); }
}

async function isBlockedEitherWay(a, b) {
  const [[row]] = await pool.execute(
    `SELECT 1 AS hit FROM user_blocks WHERE (blocker_id = :a AND blocked_id = :b) OR (blocker_id = :b AND blocked_id = :a) LIMIT 1`,
    { a, b }
  );
  return Boolean(row);
}

/* ------------------------------------------------------------------
   Admin: the reports queue, grouped by what was reported
   ------------------------------------------------------------------ */

async function describeTarget(type, id) {
  if (type === 'user') {
    const [[u]] = await pool.execute(
      `SELECT u.name, u.department, u.status, sd.employment_status,
              CASE WHEN EXISTS (SELECT 1 FROM mentors m WHERE m.user_id = u.user_id) THEN 'mentor' ELSE 'mentee' END AS role
       FROM users u LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number WHERE u.user_id = :id`,
      { id }
    );
    if (!u) return null;
    return { title: u.name, subtitle: `${u.role === 'mentor' ? 'Mentor' : 'Mentee'}${u.department ? ', ' + u.department : ''}`, ownerId: Number(id), status: u.status };
  }
  if (type === 'opportunity') {
    const [[o]] = await pool.execute(
      `SELECT co.title, co.company, co.description, co.apply_link, co.approval_status, co.posted_by, co.risk_level, co.risk_flags, u.name AS owner_name
       FROM career_opportunities co LEFT JOIN users u ON u.user_id = co.posted_by WHERE co.opportunity_id = :id`,
      { id }
    );
    if (!o) return null;
    return { title: o.title, subtitle: `Opportunity at ${o.company || 'unknown company'}, posted by ${o.owner_name}`, ownerId: o.posted_by, ownerName: o.owner_name,
      status: o.approval_status, excerpt: (o.description || '').slice(0, 280), link: o.apply_link, riskLevel: o.risk_level, riskFlags: parseFlags(o.risk_flags) };
  }
  const [[e]] = await pool.execute(
    `SELECT e.title, e.description, e.location, e.status, e.created_by, e.risk_level, e.risk_flags, u.name AS owner_name
     FROM events e LEFT JOIN users u ON u.user_id = e.created_by WHERE e.event_id = :id`,
    { id }
  );
  if (!e) return null;
  return { title: e.title, subtitle: `Event${e.owner_name ? ', proposed by ' + e.owner_name : ' by the alumni office'}`, ownerId: e.created_by, ownerName: e.owner_name,
    status: e.status, excerpt: (e.description || '').slice(0, 280), link: e.location, riskLevel: e.risk_level, riskFlags: parseFlags(e.risk_flags) };
}

function parseFlags(text) {
  try { return JSON.parse(text || '[]'); } catch { return []; }
}

async function listReports(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT r.report_id, r.target_type, r.target_id, r.reason, r.details, r.created_at, r.source,
             COALESCE(u.name, 'Automatic check') AS reporter_name
      FROM reports r LEFT JOIN users u ON u.user_id = r.reporter_id
      WHERE r.status = 'open' ORDER BY r.created_at ASC`);
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.target_type}:${r.target_id}`;
      if (!groups.has(key)) groups.set(key, { target_type: r.target_type, target_id: r.target_id, reports: [], first_at: r.created_at });
      groups.get(key).reports.push({ id: r.report_id, reason: r.reason, reason_label: REASONS[r.reason], details: r.details, reporter_name: r.reporter_name, source: r.source, created_at: r.created_at });
    }
    const result = [];
    for (const g of groups.values()) {
      const target = await describeTarget(g.target_type, g.target_id);
      if (!target) continue;
      // Earlier reports on the same person, so repeat behaviour stands out
      const [[{ past }]] = await pool.execute(
        `SELECT COUNT(*) AS past FROM reports r
         LEFT JOIN career_opportunities co ON r.target_type = 'opportunity' AND co.opportunity_id = r.target_id
         LEFT JOIN events e ON r.target_type = 'event' AND e.event_id = r.target_id
         WHERE r.status = 'actioned' AND COALESCE(IF(r.target_type = 'user', r.target_id, NULL), co.posted_by, e.created_by) = :owner`,
        { owner: target.ownerId || 0 }
      );
      const serious = g.reports.some((r) => ['asked_for_money', 'harassment', 'fake_profile'].includes(r.reason));
      // People who reported; the automatic check is shown but not counted as a person
      const reporters = new Set(g.reports.filter((r) => r.source !== 'automatic').map((r) => r.reporter_name)).size;
      const automatic = g.reports.some((r) => r.source === 'automatic');
      result.push({ ...g, target, reporters, automatic, past_actioned: past, priority: (serious ? 2 : 0) + reporters + past + (automatic ? 1 : 0) });
    }
    result.sort((a, b) => b.priority - a.priority || new Date(a.first_at) - new Date(b.first_at));
    res.json(result);
  } catch (err) { next(err); }
}

/*
 * action: dismiss | remove_content | suspend_user
 * Resolves every open report about the same target at once.
 */
async function resolveReports(req, res, next) {
  try {
    const { targetType, action } = req.body;
    const targetId = Number(req.body.targetId);
    const note = String(req.body.note || '').trim().slice(0, 255);
    if (!['dismiss', 'remove_content', 'suspend_user'].includes(action)) return res.status(400).json({ error: 'Choose an action' });
    if (action !== 'dismiss' && !note) return res.status(400).json({ error: 'Add a short note on what you found' });
    const target = await describeTarget(targetType, targetId);
    if (!target) return res.status(404).json({ error: 'Not found' });
    if (action === 'remove_content' && targetType === 'user') return res.status(400).json({ error: 'Use suspend for a member' });

    const [reports] = await pool.execute(
      "SELECT report_id, reporter_id FROM reports WHERE target_type = :targetType AND target_id = :targetId AND status = 'open'",
      { targetType, targetId }
    );
    if (!reports.length) return res.status(404).json({ error: 'These reports have already been handled' });

    const admin = require('./admin.controller');
    let summary;
    if (action === 'dismiss') {
      summary = `Dismissed ${reports.length} report${reports.length === 1 ? '' : 's'} about ${target.title}`;
      // A post hidden by reports goes back up once an admin finds nothing wrong
      if (targetType === 'opportunity' && target.status === 'pending') {
        await pool.execute("UPDATE career_opportunities SET approval_status = 'approved' WHERE opportunity_id = :targetId", { targetId });
      }
    } else if (action === 'remove_content') {
      if (targetType === 'opportunity') {
        await pool.execute("UPDATE career_opportunities SET approval_status = 'rejected' WHERE opportunity_id = :targetId", { targetId });
      } else {
        await pool.execute("UPDATE events SET status = 'rejected' WHERE event_id = :targetId", { targetId });
      }
      if (target.ownerId) {
        await createNotification(target.ownerId, 'content_removed', `Your post "${target.title}" was removed after a review by the alumni office.`, 'notifications.html');
      }
      summary = `Removed ${targetType} "${target.title}" after ${reports.length} report${reports.length === 1 ? '' : 's'}`;
    } else {
      const ownerId = target.ownerId;
      if (!ownerId) return res.status(400).json({ error: 'There is no member to suspend for this post' });
      const [[isAdmin]] = await pool.execute('SELECT 1 AS yes FROM admins WHERE user_id = :ownerId', { ownerId });
      if (isAdmin) return res.status(400).json({ error: 'Admin accounts cannot be suspended here' });
      await pool.execute(
        "UPDATE users SET status = 'suspended', session_version = session_version + 1 WHERE user_id = :ownerId",
        { ownerId }
      );
      const conn = await pool.getConnection();
      try {
        const [[m]] = await conn.execute('SELECT 1 AS yes FROM mentors WHERE user_id = :ownerId', { ownerId });
        await endOpenMentorships(conn, ownerId, m ? 'mentor' : 'mentee', 'suspended');
      } finally {
        conn.release();
      }
      if (targetType === 'opportunity') {
        await pool.execute("UPDATE career_opportunities SET approval_status = 'rejected' WHERE opportunity_id = :targetId", { targetId });
      } else if (targetType === 'event') {
        await pool.execute("UPDATE events SET status = 'rejected' WHERE event_id = :targetId", { targetId });
      }
      summary = `Suspended ${targetType === 'user' ? target.title : target.ownerName} after ${reports.length} report${reports.length === 1 ? '' : 's'}`;
    }

    await pool.execute(
      `UPDATE reports SET status = :status, resolved_by = :adminId, resolved_at = NOW(), resolution_note = :note
       WHERE target_type = :targetType AND target_id = :targetId AND status = 'open'`,
      { status: action === 'dismiss' ? 'dismissed' : 'actioned', adminId: req.user.userId, note: note || null, targetType, targetId }
    );
    await admin.logAdminAction(req.user.userId, `report_${action}`, 'reports', targetId, `${summary}${note ? '. Note: ' + note : ''}`, target.title);

    // Reporters hear back, without details of what happened to the other person
    const reporterIds = [...new Set(reports.map((r) => r.reporter_id).filter(Boolean))];
    await Promise.all(reporterIds.map((id) => createNotification(id, 'report_reviewed', 'Thank you for your report. The alumni office has reviewed it.', 'notifications.html')));

    res.json({ resolved: reports.length, action });
  } catch (err) { next(err); }
}

module.exports = { REASONS, fileAutomaticReport, createReport, listBlocks, blockUser, unblockUser, isBlockedEitherWay, listReports, resolveReports, parseFlags };
