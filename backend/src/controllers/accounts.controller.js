/*
 * Account recovery and admin management (admin tools).
 *
 * Two-factor reset: a member who has lost both their phone and their backup
 * codes cannot sign in. An admin checks who they are against the HR record
 * (for example by phoning the number HR holds, never one the caller gives),
 * then resets two-factor. Their sessions end, they are told by email and in
 * the app, and they must set two-factor up again before using AlumNet.
 *
 * Admins: added and removed in the app. With two or more active admins, a
 * different admin approves each change, so no one person can hand out admin
 * rights alone. Every step is in the activity log.
 */
const pool = require('../config/db');
const { createNotification, notifyMany } = require('../utils/notify');
const { sendMail, emailLayout } = require('../utils/mailer');
const { normaliseEmail } = require('../utils/hr');
const admin = require('./admin.controller');

const CHECK_METHODS = {
  hr_phone: 'phoned the number HR holds',
  in_person: 'met them in person and saw their staff ID',
  video_call: 'video call with their staff ID shown'
};
const REQUEST_DAYS = 7; // a waiting admin change lapses after a week

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const appUrl = () => (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');

async function activeAdmins() {
  const [rows] = await pool.query(
    "SELECT u.user_id FROM admins a JOIN users u ON u.user_id = a.user_id WHERE u.status = 'active'"
  );
  return rows.map((r) => r.user_id);
}

/* ------------------------------------------------------------ two-factor reset */

async function resetTwoFactor(req, res, next) {
  try {
    const id = Number(req.params.id);
    const method = String(req.body.method || '');
    const note = String(req.body.note || '').trim();
    if (!CHECK_METHODS[method]) return res.status(400).json({ error: 'Choose how you checked who they are' });
    if (note.length < 10) return res.status(400).json({ error: 'Write a short note on what you checked (at least 10 characters)' });
    if (note.length > 200) return res.status(400).json({ error: 'Keep the note under 200 characters' });
    if (id === req.user.userId) return res.status(403).json({ error: 'Another admin must reset your own two-factor' });

    const [[u]] = await pool.execute('SELECT user_id, name, email, status, totp_enabled FROM users WHERE user_id = :id', { id });
    if (!u || u.status === 'deleted') return res.status(404).json({ error: 'Member not found' });
    if (u.status !== 'active') return res.status(409).json({ error: 'Reactivate the account first' });
    if (!u.totp_enabled) return res.status(409).json({ error: 'Two-factor is not on for this account, so there is nothing to reset' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_setup_required = 1,
                session_version = session_version + 1 WHERE user_id = :id`, { id }
      );
      await conn.execute('DELETE FROM two_factor_backup_codes WHERE user_id = :id', { id });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const label = await admin.describeUser(id);
    await admin.logAdminAction(req.user.userId, 'reset_two_factor', 'users', id,
      `Reset two-factor for ${label} after checking who they are (${CHECK_METHODS[method]}). Note: ${note}`, label);

    const message = 'The alumni office reset two-factor authentication on your account. Sign in with your password, then set two-factor up again. If you did not ask for this, contact the alumni office straight away.';
    await createNotification(id, 'security', message, 'settings.html');
    await sendMail({
      to: u.email,
      subject: 'Two-factor authentication was reset on your AlumNet account',
      text: `Hi ${firstName(u.name)},\n\n${message}\n\nSign in: ${appUrl()}/login.html`,
      html: emailLayout('Two-factor was reset', `<p>Hi ${esc(firstName(u.name))},</p><p>${message}</p><p style="margin:24px 0;"><a href="${appUrl()}/login.html" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Sign in</a></p>`)
    }).catch((e) => console.error('Email failed:', e.message));

    res.json({ message: `Two-factor was reset for ${u.name}. They have been signed out and must set it up again.` });
  } catch (err) { next(err); }
}

/* ------------------------------------------------------------ admins */

async function listAdmins(req, res, next) {
  try {
    const [admins] = await pool.query(
      `SELECT u.user_id, u.name, u.email, u.status, u.totp_enabled, u.last_login_at, a.added_at, ab.name AS added_by_name
       FROM admins a JOIN users u ON u.user_id = a.user_id LEFT JOIN users ab ON ab.user_id = a.added_by
       WHERE u.status != 'deleted' ORDER BY u.name`
    );
    const [requests] = await pool.query(
      `SELECT r.request_id, r.action, r.note, r.created_at, r.requested_by, rb.name AS requested_by_name,
              t.user_id AS target_id, t.name AS target_name, t.email AS target_email
       FROM admin_role_requests r JOIN users rb ON rb.user_id = r.requested_by JOIN users t ON t.user_id = r.target_user_id
       WHERE r.status = 'waiting' AND r.created_at > DATE_SUB(NOW(), INTERVAL ${REQUEST_DAYS} DAY)
       ORDER BY r.created_at`
    );
    res.json({
      admins: admins.map((a) => ({ ...a, totp_enabled: Boolean(a.totp_enabled), me: a.user_id === req.user.userId })),
      requests: requests.map((r) => ({ ...r, mine: r.requested_by === req.user.userId })),
      active_admins: admins.filter((a) => a.status === 'active').length
    });
  } catch (err) { next(err); }
}

async function applyAdminChange({ action, target, by, approvedBy = null, note = '' }) {
  if (action === 'add') {
    await pool.execute(
      `INSERT INTO admins (user_id, admin_level, added_by, added_at) VALUES (:id, 'standard', :by, NOW())
       ON DUPLICATE KEY UPDATE user_id = user_id`,
      { id: target.user_id, by }
    );
  } else {
    await pool.execute('DELETE FROM admins WHERE user_id = :id', { id: target.user_id });
  }
  // Sign them out everywhere, so the next sign-in picks up the new role
  await pool.execute('UPDATE users SET session_version = session_version + 1 WHERE user_id = :id', { id: target.user_id });

  const label = await admin.describeUser(target.user_id);
  const how = approvedBy ? ' (approved by a second admin)' : ' (only one admin, so no second check was possible)';
  await admin.logAdminAction(approvedBy || by, action === 'add' ? 'add_admin' : 'remove_admin', 'users', target.user_id,
    `${action === 'add' ? 'Made' : 'Removed'} ${label} ${action === 'add' ? 'an admin' : 'as an admin'}${how}${note ? `. Reason: ${note}` : ''}`, label);

  const message = action === 'add'
    ? 'You are now an AlumNet admin. Sign in again, then turn on two-factor authentication in Account settings to open the admin tools.'
    : 'You are no longer an AlumNet admin. Sign in again to carry on with your member account, if you have one.';
  await createNotification(target.user_id, 'security', message, action === 'add' ? 'settings.html' : 'login.html');
  await sendMail({
    to: target.email,
    subject: action === 'add' ? 'You are now an AlumNet admin' : 'Your AlumNet admin access has ended',
    text: `Hi ${firstName(target.name)},\n\n${message}\n\nIf you did not expect this, contact the alumni office.`,
    html: emailLayout(action === 'add' ? 'You are now an admin' : 'Admin access ended',
      `<p>Hi ${esc(firstName(target.name))},</p><p>${message}</p><p style="font-size:13px;color:#45524C;">If you did not expect this, contact the alumni office.</p>`)
  }).catch((e) => console.error('Email failed:', e.message));
}

async function requestAdminChange(req, res, next) {
  try {
    const action = req.body.action;
    const note = String(req.body.note || '').trim().slice(0, 200);
    if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: 'Choose add or remove' });

    let target;
    if (action === 'add') {
      const email = normaliseEmail(req.body.email);
      if (!email) return res.status(400).json({ error: 'Enter the email of their AlumNet account' });
      [[target]] = await pool.execute('SELECT user_id, name, email, status FROM users WHERE email = :email', { email });
      if (!target || target.status === 'deleted') return res.status(404).json({ error: 'No AlumNet account uses that email. They need to register first.' });
      if (target.status !== 'active') return res.status(409).json({ error: 'That account is suspended' });
    } else {
      [[target]] = await pool.execute('SELECT user_id, name, email, status FROM users WHERE user_id = :id', { id: Number(req.body.userId) });
      if (!target) return res.status(404).json({ error: 'Admin not found' });
    }
    const [[isAdmin]] = await pool.execute('SELECT user_id FROM admins WHERE user_id = :id', { id: target.user_id });
    if (action === 'add' && isAdmin) return res.status(409).json({ error: `${target.name} is already an admin` });
    if (action === 'remove' && !isAdmin) return res.status(409).json({ error: `${target.name} is not an admin` });

    const admins = await activeAdmins();
    if (action === 'remove' && admins.length <= 1) return res.status(409).json({ error: 'AlumNet must always have at least one admin' });

    const [[waiting]] = await pool.execute(
      `SELECT request_id FROM admin_role_requests WHERE target_user_id = :id AND status = 'waiting'
       AND created_at > DATE_SUB(NOW(), INTERVAL ${REQUEST_DAYS} DAY)`, { id: target.user_id }
    );
    if (waiting) return res.status(409).json({ error: `A change for ${target.name} is already waiting for approval` });

    // Removing always needs a second admin; adding does too, once there are two admins
    if (admins.length >= 2) {
      const [ins] = await pool.execute(
        'INSERT INTO admin_role_requests (action, target_user_id, requested_by, note) VALUES (:action, :target, :by, :note)',
        { action, target: target.user_id, by: req.user.userId, note: note || null }
      );
      const label = await admin.describeUser(target.user_id);
      await admin.logAdminAction(req.user.userId, 'request_admin_change', 'users', target.user_id,
        `Asked a second admin to ${action === 'add' ? 'make' : 'remove'} ${label} ${action === 'add' ? 'an admin' : 'as an admin'}${note ? `. Reason: ${note}` : ''}`, label);
      await notifyMany(admins.filter((a) => a !== req.user.userId), 'admin_change_waiting',
        `A request to ${action === 'add' ? 'make' : 'remove'} ${target.name} ${action === 'add' ? 'an admin' : 'as an admin'} is waiting for your approval.`, 'admin.html#admins');
      return res.status(202).json({ waitingForSecondAdmin: true, requestId: ins.insertId,
        message: `Sent for approval. Another admin must approve it within ${REQUEST_DAYS} days.` });
    }

    await applyAdminChange({ action, target, by: req.user.userId, note });
    res.json({ message: `${target.name} is now an admin. They must turn on two-factor before the admin tools open.` });
  } catch (err) { next(err); }
}

async function decideAdminRequest(req, res, next) {
  try {
    const id = Number(req.params.id);
    const decision = req.body.decision;
    if (!['approve', 'reject', 'cancel'].includes(decision)) return res.status(400).json({ error: 'Choose approve, reject or cancel' });
    const [[r]] = await pool.execute(
      `SELECT r.*, t.name AS target_name, t.email AS target_email, t.status AS target_status FROM admin_role_requests r
       JOIN users t ON t.user_id = r.target_user_id
       WHERE r.request_id = :id AND r.status = 'waiting' AND r.created_at > DATE_SUB(NOW(), INTERVAL ${REQUEST_DAYS} DAY)`, { id }
    );
    if (!r) return res.status(404).json({ error: 'This request is not waiting any more' });

    const mine = r.requested_by === req.user.userId;
    if (decision === 'cancel' && !mine) return res.status(403).json({ error: 'Only the admin who asked can cancel it' });
    if (decision !== 'cancel' && mine) return res.status(403).json({ error: 'A different admin must approve a change you asked for' });
    if (decision === 'approve' && r.action === 'remove' && (await activeAdmins()).length <= 1) {
      return res.status(409).json({ error: 'AlumNet must always have at least one admin' });
    }
    if (decision === 'approve' && r.action === 'add' && r.target_status !== 'active') {
      return res.status(409).json({ error: 'That account is no longer active' });
    }

    const state = { approve: 'applied', reject: 'rejected', cancel: 'cancelled' }[decision];
    // Claim it first, so two admins cannot both decide it
    const [claim] = await pool.execute(
      "UPDATE admin_role_requests SET status = :state, decided_by = :by, decided_at = NOW() WHERE request_id = :id AND status = 'waiting'",
      { state, by: req.user.userId, id }
    );
    if (!claim.affectedRows) return res.status(409).json({ error: 'Another admin has just decided this' });

    const what = `${r.action === 'add' ? 'make' : 'remove'} ${r.target_name} ${r.action === 'add' ? 'an admin' : 'as an admin'}`;
    if (decision === 'approve') {
      await applyAdminChange({ action: r.action, target: { user_id: r.target_user_id, name: r.target_name, email: r.target_email },
        by: r.requested_by, approvedBy: req.user.userId, note: r.note });
    } else {
      await admin.logAdminAction(req.user.userId, decision === 'reject' ? 'reject_admin_change' : 'cancel_admin_change', 'users', r.target_user_id,
        `${decision === 'reject' ? 'Rejected' : 'Cancelled'} the request to ${what}`, r.target_name);
    }
    if (!mine) {
      await createNotification(r.requested_by, 'admin_change_decided',
        `Your request to ${what} was ${decision === 'approve' ? 'approved' : 'rejected'}.`, 'admin.html#admins');
    }
    res.json({ message: { approve: 'Approved and applied.', reject: 'Rejected. Nothing was changed.', cancel: 'Cancelled.' }[decision] });
  } catch (err) { next(err); }
}

module.exports = { resetTwoFactor, listAdmins, requestAdminChange, decideAdminRequest, CHECK_METHODS, REQUEST_DAYS };
