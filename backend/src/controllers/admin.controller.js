const pool = require('../config/db');
const { validateEventInput } = require('./events.controller');
const bcrypt = require('bcrypt');
const { createNotification, notifyMany } = require('../utils/notify');
const { sendMail, emailLayout } = require('../utils/mailer');
const { findStaff, canJoin, roleForStaff, normaliseStaffNumber, normaliseEmail, resolveRole } = require('../utils/hr');

async function getStats(req, res, next) {
    try {
        const [[{ totalAlumni }]] = await pool.query(
            `SELECT COUNT(*) AS totalAlumni FROM users u
       WHERE EXISTS (SELECT 1 FROM mentees m WHERE m.user_id = u.user_id)
          OR EXISTS (SELECT 1 FROM mentors m WHERE m.user_id = u.user_id)`
        );
        const [[{ activeMentorships }]] = await pool.query(
            `SELECT COUNT(*) AS activeMentorships FROM mentorship_requests WHERE status = 'accepted'`
        );
        const [[{ pendingRequests }]] = await pool.query(
            `SELECT COUNT(*) AS pendingRequests FROM mentorship_requests WHERE status = 'pending'`
        );
        const [[{ flaggedAccounts }]] = await pool.query(
            `SELECT COUNT(*) AS flaggedAccounts FROM users WHERE status = 'suspended'`
        );
        const [[{ openReports }]] = await pool.query(
            `SELECT COUNT(DISTINCT target_type, target_id) AS openReports FROM reports WHERE status = 'open'`
        );
        res.json({ totalAlumni, activeMentorships, pendingRequests, flaggedAccounts, openReports });
    } catch (err) { next(err); }
}

async function listUsers(req, res, next) {
    try {
        const [rows] = await pool.query(`
      SELECT u.user_id, u.name, u.email, u.status, u.created_at, u.department, u.staff_number,
             u.last_login_at, u.totp_enabled, sd.employment_status,
        CASE
          WHEN ad.user_id IS NOT NULL THEN 'admin'
          WHEN sd.employment_status = 'former' THEN 'mentor'
          WHEN sd.employment_status = 'active' THEN 'mentee'
          WHEN mo.user_id IS NOT NULL THEN 'mentor'
          WHEN me.user_id IS NOT NULL THEN 'mentee'
        END AS role
      FROM users u
      LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
      LEFT JOIN mentees me ON me.user_id = u.user_id
      LEFT JOIN mentors mo ON mo.user_id = u.user_id
      LEFT JOIN admins ad ON ad.user_id = u.user_id
      WHERE u.status != 'deleted'
      ORDER BY u.created_at DESC, u.user_id DESC
    `);
        res.json(rows);
    } catch (err) { next(err); }
}

async function toggleUserStatus(req, res, next) {
    try {
        const { id } = req.params;
        const [[user]] = await pool.execute('SELECT status FROM users WHERE user_id = :id', { id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.status === 'deleted') return res.status(400).json({ error: 'This account has been deleted' });
        if (Number(id) === req.user.userId) return res.status(400).json({ error: 'You cannot suspend your own account' });

        const newStatus = user.status === 'active' ? 'suspended' : 'active';
        const reason = String((req.body && req.body.reason) || '').trim().slice(0, 150);
        await pool.execute(
          'UPDATE users SET status = :newStatus, session_version = session_version + 1 WHERE user_id = :id',
          { newStatus, id }
        );

        const label = await describeUser(id);
        await logAdminAction(
          req.user.userId,
          newStatus === 'suspended' ? 'suspend_user' : 'reactivate_user',
          'users', id,
          `${newStatus === 'suspended' ? 'Suspended' : 'Reactivated'} ${label}${reason ? `. Reason: ${reason}` : ''}`,
          label
        );
        await createNotification(
          id, 'account_status',
          newStatus === 'suspended'
            ? 'Your account has been suspended. Contact the alumni office if you think this is a mistake.'
            : 'Your account has been reactivated.',
          'login.html'
        );

        res.json({ user_id: Number(id), status: newStatus });
    } catch (err) { next(err); }
}

async function listEvents(req, res, next) {
    try {
        const [rows] = await pool.query('SELECT * FROM events ORDER BY event_date DESC');
        res.json(rows);
    } catch (err) { next(err); }
}

async function createEvent(req, res, next) {
  try {
    const error = validateEventInput(req.body);
    if (error) return res.status(400).json({ error });

    const { title, eventDate, description, mode, location, capacity } = req.body;
    const [result] = await pool.execute(
      `INSERT INTO events (title, event_date, description, mode, location, capacity, created_by, status)
       VALUES (:title, :eventDate, :description, :mode, :location, :capacity, :userId, 'approved')`,
      {
        title: title.trim(),
        eventDate,
        description: description || null,
        mode,
        location: location.trim(),
        capacity: capacity ? Number(capacity) : null,
        userId: req.user.userId
      }
    );

    await logAdminAction(req.user.userId, 'create_event', 'events', result.insertId, `Created event "${title.trim()}"`, title.trim());

    res.status(201).json({ eventId: result.insertId });
  } catch (err) {
    next(err);
  }
}


// Scam check results are stored as JSON text
function withFlags(row) {
  let flags = [];
  try { flags = JSON.parse(row.risk_flags || '[]'); } catch { /* keep empty */ }
  return { ...row, risk_flags: flags, open_reports: Number(row.open_reports || 0) };
}

async function listPendingEvents(req, res, next) {
  try {
    const [rows] = await pool.execute(
      `SELECT e.event_id, e.title, e.event_date, e.description, e.mode, e.location, e.capacity,
              e.risk_level, e.risk_flags, u.name AS proposed_by_name,
              (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'event' AND r.target_id = e.event_id AND r.status = 'open') AS open_reports
       FROM events e
       JOIN users u ON u.user_id = e.created_by
       WHERE e.status = 'pending'
       ORDER BY FIELD(e.risk_level, 'high', 'medium', 'low') ASC, e.event_date ASC`
    );
    res.json(rows.map(withFlags));
  } catch (err) {
    next(err);
  }
}

async function reviewEvent(req, res, next) {
  try {
    const { decision } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approved or rejected' });
    }
    const eventId = req.params.id;
    const [result] = await pool.execute(
      `UPDATE events SET status = :decision WHERE event_id = :eventId AND status = 'pending'`,
      { decision, eventId }
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Event not found or already reviewed' });
    }

    // Tell the mentor who proposed it
    const [[event]] = await pool.execute(
      `SELECT e.title, e.created_by, u.name AS proposer FROM events e
       LEFT JOIN users u ON u.user_id = e.created_by WHERE e.event_id = :eventId`,
      { eventId }
    );
    await logAdminAction(
      req.user.userId, `${decision}_event`, 'events', eventId,
      `${decision === 'approved' ? 'Approved' : 'Rejected'} event "${event.title}"${event.proposer ? ` proposed by ${event.proposer}` : ''}`,
      event.title
    );
    if (event && event.created_by) {
      await createNotification(
        event.created_by,
        `event_${decision}`,
        decision === 'approved'
          ? `Your event "${event.title}" was approved and is now live.`
          : `Your event "${event.title}" was not approved.`,
        'events.html'
      );
    }

    res.json({ message: `Event ${decision}` });
  } catch (err) {
    next(err);
  }
}

async function deleteEvent(req, res, next) {
    try {
        const { id } = req.params;

        // deleting the event also deletes its registrations
        const [[event]] = await pool.execute('SELECT title FROM events WHERE event_id = :id', { id });
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const [registrants] = await pool.execute(
            'SELECT user_id FROM event_registrations WHERE event_id = :id',
            { id }
        );

        await pool.execute('DELETE FROM events WHERE event_id = :id', { id });
        await logAdminAction(req.user.userId, 'delete_event', 'events', id, `Deleted event "${event.title}"`, event.title);

        await notifyMany(
            registrants.map((r) => r.user_id),
            'event_cancelled',
            `"${event.title}" has been cancelled by the organisers.`,
            'events.html'
        );

        res.json({ success: true });
    } catch (err) { next(err); }
}
async function listPendingOpportunities(req, res, next) {
    try {
        const [rows] = await pool.query(`
      SELECT co.*, u.name AS posted_by_name,
             (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'opportunity' AND r.target_id = co.opportunity_id AND r.status = 'open') AS open_reports
      FROM career_opportunities co JOIN users u ON u.user_id = co.posted_by
      WHERE co.approval_status = 'pending'
      ORDER BY FIELD(co.risk_level, 'high', 'medium', 'low') ASC, co.opportunity_id DESC
    `);
        res.json(rows.map(withFlags));
    } catch (err) { next(err); }
}

async function reviewOpportunity(req, res, next) {
    try {
        const { id } = req.params;
        const { decision, reviewNotes } = req.body;
        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
        }

        const [[opportunity]] = await pool.execute(
            `SELECT co.title, co.posted_by, u.name AS poster FROM career_opportunities co
             LEFT JOIN users u ON u.user_id = co.posted_by WHERE co.opportunity_id = :id`,
            { id }
        );
        if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });

        await pool.execute(
            'UPDATE career_opportunities SET approval_status = :decision WHERE opportunity_id = :id',
            { decision, id }
        );
        await pool.execute(
            `INSERT INTO content_approvals (admin_id, opportunity_id, status, review_notes)
       VALUES (:adminId, :id, :decision, :reviewNotes)`,
            { adminId: req.user.userId, id, decision, reviewNotes: reviewNotes || null }
        );
        await logAdminAction(
            req.user.userId, `${decision}_opportunity`, 'career_opportunities', id,
            `${decision === 'approved' ? 'Approved' : 'Rejected'} opportunity "${opportunity.title}"${opportunity.poster ? ` posted by ${opportunity.poster}` : ''}`,
            opportunity.title
        );

        // Tell the mentor who posted it
        await createNotification(
            opportunity.posted_by,
            `opportunity_${decision}`,
            decision === 'approved'
                ? `Your opportunity "${opportunity.title}" was approved and is now visible to the network.`
                : `Your opportunity "${opportunity.title}" was not approved.`,
            'opportunities.html'
        );

        res.json({ opportunity_id: Number(id), status: decision });
    } catch (err) { next(err); }
}

async function listActivityLogs(req, res, next) {
    try {
        const [rows] = await pool.query(`
      SELECT l.*, u.name AS admin_name
      FROM admin_activity_logs l JOIN users u ON u.user_id = l.admin_id
      ORDER BY l.created_at DESC, l.log_id DESC LIMIT 50
    `);
        res.json(rows);
    } catch (err) { next(err); }
}

// Names are saved at the time of the action, so the log stays readable even
// if the person or item is later renamed or deleted
async function logAdminAction(adminId, actionType, targetEntity, targetEntityId, description, targetLabel = null) {
    await pool.execute(
        `INSERT INTO admin_activity_logs (admin_id, action_type, target_entity, target_entity_id, target_label, description)
     VALUES (:adminId, :actionType, :targetEntity, :targetEntityId, :targetLabel, :description)`,
        {
          adminId, actionType, targetEntity, targetEntityId: Number(targetEntityId) || 0,
          targetLabel: targetLabel ? String(targetLabel).slice(0, 255) : null,
          description: description ? String(description).slice(0, 255) : null
        }
    );
}

// "Peter Kamau (mentee, Ground Operations)"
async function describeUser(userId) {
    const [[u]] = await pool.execute(
      `SELECT u.name, u.department,
              CASE WHEN ad.user_id IS NOT NULL THEN 'admin'
                   WHEN sd.employment_status = 'former' OR (sd.employment_status IS NULL AND mo.user_id IS NOT NULL) THEN 'mentor'
                   ELSE 'mentee' END AS role
       FROM users u
       LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
       LEFT JOIN admins ad ON ad.user_id = u.user_id
       LEFT JOIN mentors mo ON mo.user_id = u.user_id
       WHERE u.user_id = :userId`,
      { userId }
    );
    if (!u) return `user #${userId}`;
    return `${u.name} (${[u.role, u.department].filter(Boolean).join(', ')})`;
}

/* ------------------------------------------------------------------
   Sign-up verification queue
   ------------------------------------------------------------------ */

async function listSignupRequests(req, res, next) {
    try {
        const [rows] = await pool.query(`
      SELECT r.request_id, r.staff_number, r.email, r.full_name, r.phone, r.risk_level, r.risk_signals,
             r.created_at, sd.full_name AS hr_name, sd.department AS hr_department,
             sd.employment_status AS hr_status, sd.mobile_number AS hr_phone
      FROM signup_requests r
      LEFT JOIN staff_directory sd ON sd.staff_number = r.staff_number
      WHERE r.status = 'pending_review' AND r.expires_at > NOW()
      ORDER BY FIELD(r.risk_level, 'low', 'medium', 'high'), r.created_at ASC
    `);
        res.json(rows.map((r) => {
          let parsed = {};
          try { parsed = JSON.parse(r.risk_signals || '{}'); } catch { /* keep empty */ }
          return {
            ...r,
            risk_signals: undefined,
            suggestion: parsed.suggestion || null,
            signals: parsed.signals || [],
            role_if_approved: r.hr_status ? roleForStaff({ employment_status: r.hr_status }) : null
          };
        }));
    } catch (err) { next(err); }
}

async function reviewSignupRequest(req, res, next) {
    try {
        const { id } = req.params;
        const { decision } = req.body;
        const note = String(req.body.note || '').trim().slice(0, 255);
        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
        }
        if (decision === 'rejected' && !note) return res.status(400).json({ error: 'Give a short reason for rejecting' });

        const [[request]] = await pool.execute(
            `SELECT * FROM signup_requests WHERE request_id = :id AND status = 'pending_review'`,
            { id }
        );
        if (!request) return res.status(404).json({ error: 'Request not found or already reviewed' });

        const label = `${request.full_name} (${request.staff_number})`;
        const loginLink = `${(process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '')}/login.html`;

        if (decision === 'approved') {
            const staff = await findStaff(request.staff_number);
            if (!canJoin(staff)) return res.status(400).json({ error: 'This staff number is not in HR records or is not eligible, so it cannot be approved.' });
            const [[taken]] = await pool.execute(
              'SELECT user_id FROM users WHERE staff_number = :s OR email = :e',
              { s: staff.staff_number, e: request.email }
            );
            if (taken) return res.status(409).json({ error: 'An account already exists for this staff number or email.' });

            // The account is created from the HR record, not from what was typed
            const { createAccount } = require('./auth.controller');
            const { role } = await createAccount({
              staff, email: request.email, passwordHash: request.password_hash, privacyAcceptedAt: request.privacy_accepted_at
            });
            await pool.execute(
              `UPDATE signup_requests SET status = 'approved', password_hash = NULL, reviewed_by = :admin, reviewed_at = NOW(), review_note = :note
               WHERE request_id = :id`,
              { admin: req.user.userId, note: note || null, id }
            );
            await logAdminAction(req.user.userId, 'approve_signup', 'signup_requests', id,
              `Approved sign-up for ${staff.full_name} (${staff.staff_number}) as ${role}${note ? `. Note: ${note}` : ''}`, label);
            await sendMail({
              to: request.email,
              subject: 'You are verified on AlumNet',
              text: `Hi ${staff.full_name.split(' ')[0]},\n\nThe alumni office has verified your registration. Log in with your email and the password you chose: ${loginLink}`,
              html: emailLayout('You are verified', `<p>Hi ${staff.full_name.split(' ')[0]},</p><p>The alumni office has verified your registration. Log in with your email and the password you chose.</p><p style="margin:24px 0;"><a href="${loginLink}" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Log in to AlumNet</a></p>`)
            }).catch((e) => console.error('Email failed:', e.message));
            return res.json({ status: 'approved', role });
        }

        await pool.execute(
          `UPDATE signup_requests SET status = 'rejected', password_hash = NULL, reviewed_by = :admin, reviewed_at = NOW(), review_note = :note
           WHERE request_id = :id`,
          { admin: req.user.userId, note, id }
        );
        await logAdminAction(req.user.userId, 'reject_signup', 'signup_requests', id,
          `Rejected sign-up for ${label}. Reason: ${note}`, label);
        await sendMail({
          to: request.email,
          subject: 'About your AlumNet registration',
          text: 'Hello,\n\nThe alumni office could not verify your AlumNet registration. If you believe this is a mistake, contact the Kenya Airways alumni office.',
          html: emailLayout('We could not verify your registration', '<p>Hello,</p><p>The alumni office could not verify your AlumNet registration. If you believe this is a mistake, contact the Kenya Airways alumni office.</p>')
        }).catch((e) => console.error('Email failed:', e.message));
        res.json({ status: 'rejected' });
    } catch (err) { next(err); }
}

/* ------------------------------------------------------------------
   HR records import: preview the changes, then apply them
   ------------------------------------------------------------------ */

const HR_FIELDS = ['full_name', 'department', 'kq_email', 'personal_email', 'mobile_number', 'employment_status', 'alumni_eligible'];
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanHrRow(raw, index) {
    const row = {
      staff_number: normaliseStaffNumber(raw.staff_number),
      full_name: String(raw.full_name || '').trim(),
      department: String(raw.department || '').trim(),
      kq_email: raw.kq_email ? normaliseEmail(raw.kq_email) : null,
      personal_email: raw.personal_email ? normaliseEmail(raw.personal_email) : null,
      mobile_number: raw.mobile_number ? String(raw.mobile_number).trim() : null,
      employment_status: String(raw.employment_status || '').trim().toLowerCase(),
      alumni_eligible: ['0', 'false', 'no', 'n'].includes(String(raw.alumni_eligible ?? '1').trim().toLowerCase()) ? 0 : 1,
      id_number: raw.id_number ? String(raw.id_number).trim() : null
    };
    const errors = [];
    if (!/^[A-Z0-9]{3,20}$/.test(row.staff_number)) errors.push('staff number missing or invalid');
    if (!row.full_name) errors.push('name missing');
    if (!row.department) errors.push('department missing');
    if (!['active', 'former'].includes(row.employment_status)) errors.push('status must be active or former');
    if (row.kq_email && !SIMPLE_EMAIL.test(row.kq_email)) errors.push('work email invalid');
    if (row.personal_email && !SIMPLE_EMAIL.test(row.personal_email)) errors.push('personal email invalid');
    return { row, errors, line: index + 2 };
}

async function diffHr(rows) {
    if (!Array.isArray(rows) || !rows.length) return { error: 'The file has no rows' };
    if (rows.length > 5000) return { error: 'Import at most 5,000 rows at a time' };
    const checked = rows.map(cleanHrRow);
    const seen = new Set();
    checked.forEach((c) => {
      if (seen.has(c.row.staff_number)) c.errors.push('duplicate staff number in file');
      seen.add(c.row.staff_number);
    });

    const [existing] = await pool.query(`
      SELECT sd.*, u.user_id, u.name AS account_name FROM staff_directory sd
      LEFT JOIN users u ON u.staff_number = sd.staff_number`);
    const byNumber = new Map(existing.map((e) => [e.staff_number, e]));

    const result = { added: [], updated: [], unchanged: 0, invalid: [], retiring: [], ineligible: [] };
    for (const c of checked) {
      if (c.errors.length) { result.invalid.push({ line: c.line, staff_number: c.row.staff_number, errors: c.errors }); continue; }
      const old = byNumber.get(c.row.staff_number);
      if (!old) { result.added.push({ staff_number: c.row.staff_number, full_name: c.row.full_name }); continue; }
      const changes = HR_FIELDS.filter((f) => String(old[f] ?? '') !== String(c.row[f] ?? '')).map((f) => f);
      if (!changes.length) { result.unchanged++; continue; }
      result.updated.push({ staff_number: c.row.staff_number, full_name: c.row.full_name, changes });
      if (old.user_id && old.employment_status === 'active' && c.row.employment_status === 'former') {
        result.retiring.push({ staff_number: c.row.staff_number, full_name: c.row.full_name });
      }
      if (old.user_id && old.alumni_eligible && !c.row.alumni_eligible) {
        result.ineligible.push({ staff_number: c.row.staff_number, full_name: c.row.full_name });
      }
    }
    return { result, checked: checked.filter((c) => !c.errors.length).map((c) => c.row) };
}

async function previewHrImport(req, res, next) {
    try {
        const diff = await diffHr(req.body.rows);
        if (diff.error) return res.status(400).json({ error: diff.error });
        res.json(diff.result);
    } catch (err) { next(err); }
}

async function applyHrImport(req, res, next) {
    try {
        const diff = await diffHr(req.body.rows);
        if (diff.error) return res.status(400).json({ error: diff.error });
        const { result, checked } = diff;
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          for (const r of checked) {
            await conn.execute(
              `INSERT INTO staff_directory (staff_number, id_number, full_name, department, mobile_number, kq_email, personal_email, employment_status, alumni_eligible)
               VALUES (:staff_number, :id_number, :full_name, :department, :mobile_number, :kq_email, :personal_email, :employment_status, :alumni_eligible)
               ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), department = VALUES(department),
                 mobile_number = VALUES(mobile_number), kq_email = VALUES(kq_email), personal_email = VALUES(personal_email),
                 employment_status = VALUES(employment_status), alumni_eligible = VALUES(alumni_eligible),
                 id_number = IF(:has_id, VALUES(id_number), id_number)`,
              { ...r, id_number: r.id_number || `HR-${r.staff_number}`, has_id: r.id_number ? 1 : 0 }
            );
          }
          // People whose status or eligibility changed are signed out, so their
          // role is worked out again from the new HR record when they return
          const changedNumbers = result.updated.map((u) => u.staff_number);
          if (changedNumbers.length) {
            await conn.query(
              `UPDATE users SET session_version = session_version + 1, department = (
                 SELECT sd.department FROM staff_directory sd WHERE sd.staff_number = users.staff_number)
               WHERE staff_number IN (?)`,
              [changedNumbers]
            );
          }
          await conn.commit();
        } catch (err) {
          await conn.rollback();
          throw err;
        } finally {
          conn.release();
        }

        // Switch roles straight away for people who have retired
        for (const r of result.retiring) {
          const [[u]] = await pool.execute('SELECT user_id FROM users WHERE staff_number = :s', { s: r.staff_number });
          if (u) await resolveRole(u.user_id);
        }

        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const summary = `${result.added.length} new, ${result.updated.length} updated, ${result.retiring.length} now former staff, ${plural(result.invalid.length, 'row')} skipped`;
        await logAdminAction(req.user.userId, 'import_hr', 'staff_directory', 0, `Imported HR update: ${summary}`, 'HR records');
        res.json({ ...result, summary });
    } catch (err) { next(err); }
}

module.exports = {
  logAdminAction,
  getStats, listUsers, toggleUserStatus,
  listSignupRequests, reviewSignupRequest,
  previewHrImport, applyHrImport,
  listEvents, createEvent, deleteEvent,
  listPendingEvents, reviewEvent,
  listPendingOpportunities, reviewOpportunity,
  listActivityLogs
};