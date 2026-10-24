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

/*
 * Everything the alumni office needs about one member in one place, for
 * questions like "why can this person not sign in?" or "is this mentor
 * reliable?". Opening it is logged, because it shows personal data.
 */
async function getUserDetail(req, res, next) {
    try {
        const id = Number(req.params.id);
        const [[u]] = await pool.execute(
          `SELECT u.user_id, u.name, u.email, u.status, u.created_at, u.last_login_at, u.department, u.staff_number,
                  u.totp_enabled, u.google_id IS NOT NULL AS google_linked, u.city, u.country, u.onboarded_at,
                  sd.full_name AS hr_name, sd.department AS hr_department, sd.employment_status, sd.alumni_eligible,
                  ad.user_id IS NOT NULL AS is_admin, me.user_id IS NOT NULL AS is_mentee, mo.user_id IS NOT NULL AS is_mentor,
                  mo.accepting_mentees, mo.max_mentees, mo.meeting_mode, mo.years_of_experience,
                  p.headline, p.skills, p.career_interests
           FROM users u
           LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
           LEFT JOIN admins ad ON ad.user_id = u.user_id
           LEFT JOIN mentees me ON me.user_id = u.user_id
           LEFT JOIN mentors mo ON mo.user_id = u.user_id
           LEFT JOIN profiles p ON p.user_id = u.user_id
           WHERE u.user_id = :id`, { id }
        );
        if (!u) return res.status(404).json({ error: 'Member not found' });
        const role = u.is_admin ? 'admin'
          : u.employment_status === 'former' ? 'mentor' : u.employment_status === 'active' ? 'mentee'
            : u.is_mentor ? 'mentor' : u.is_mentee ? 'mentee' : null;

        const [mentorships] = await pool.execute(
          `SELECT r.request_id, r.status, r.requested_at, r.responded_at, r.ended_at,
                  IF(r.mentee_id = :id, 'mentee', 'mentor') AS their_side, o.user_id AS other_id, o.name AS other_name,
                  (SELECT COUNT(*) FROM mentorship_goals g WHERE g.request_id = r.request_id) AS goals_total,
                  (SELECT COUNT(*) FROM mentorship_goals g WHERE g.request_id = r.request_id AND g.done_at IS NOT NULL) AS goals_done,
                  (SELECT COUNT(*) FROM mentorship_meetings m WHERE m.request_id = r.request_id) AS meetings,
                  (SELECT helpful FROM mentorship_feedback f WHERE f.request_id = r.request_id AND f.side = 'mentee') AS mentee_rating,
                  (SELECT helpful FROM mentorship_feedback f WHERE f.request_id = r.request_id AND f.side = 'mentor') AS mentor_rating,
                  (SELECT MIN(felt_safe) FROM mentorship_feedback f WHERE f.request_id = r.request_id) AS felt_safe
           FROM mentorship_requests r
           JOIN users o ON o.user_id = IF(r.mentee_id = :id, r.mentor_id, r.mentee_id)
           WHERE r.mentee_id = :id OR r.mentor_id = :id
           ORDER BY r.requested_at DESC LIMIT 50`, { id }
        );

        // As a mentor: how they respond, and what their mentees said (only with 3 or more answers)
        let mentorStats = null;
        if (role === 'mentor' || u.is_mentor) {
          const [[st]] = await pool.execute(
            `SELECT COUNT(*) AS received,
                    SUM(status IN ('accepted','ended')) AS accepted,
                    SUM(status = 'declined') AS declined,
                    SUM(status = 'expired') AS expired,
                    SUM(status = 'pending') AS pending,
                    SUM(status = 'accepted') AS active,
                    AVG(IF(responded_at IS NOT NULL, TIMESTAMPDIFF(HOUR, requested_at, responded_at), NULL)) AS avg_reply_hours
             FROM mentorship_requests WHERE mentor_id = :id`, { id }
          );
          const [[fb]] = await pool.execute(
            `SELECT COUNT(*) AS answers, AVG(f.helpful) AS avg_helpful, SUM(f.met) AS met
             FROM mentorship_feedback f JOIN mentorship_requests r ON r.request_id = f.request_id
             WHERE r.mentor_id = :id AND f.side = 'mentee'`, { id }
          );
          const answers = Number(fb.answers);
          mentorStats = {
            received: Number(st.received), accepted: Number(st.accepted || 0), declined: Number(st.declined || 0),
            expired: Number(st.expired || 0), pending: Number(st.pending || 0), active: Number(st.active || 0),
            max_mentees: u.max_mentees, accepting: Boolean(u.accepting_mentees),
            avg_reply_hours: st.avg_reply_hours === null ? null : Math.round(Number(st.avg_reply_hours)),
            feedback_answers: answers,
            // A single bad (or good) rating says little, so averages need at least 3 answers
            avg_helpful: answers >= 3 ? Math.round(Number(fb.avg_helpful) * 10) / 10 : null
          };
        }

        const [posts] = await pool.execute(
          `SELECT 'opportunity' AS kind, opportunity_id AS id, title, approval_status AS status, created_at FROM career_opportunities WHERE posted_by = :id
           UNION ALL
           SELECT 'event', event_id, title, status, COALESCE(created_at, event_date) FROM events WHERE created_by = :id
           ORDER BY created_at DESC LIMIT 30`, { id }
        );
        const [reportsAbout] = await pool.execute(
          `SELECT r.report_id, r.reason, r.status, r.source, r.created_at, r.details, rp.name AS reporter_name
           FROM reports r LEFT JOIN users rp ON rp.user_id = r.reporter_id
           WHERE r.target_type = 'user' AND r.target_id = :id ORDER BY r.created_at DESC LIMIT 30`, { id }
        );
        const [[{ reportsMade }]] = await pool.execute('SELECT COUNT(*) AS reportsMade FROM reports WHERE reporter_id = :id', { id });
        const [[{ blockedBy }]] = await pool.execute('SELECT COUNT(*) AS blockedBy FROM user_blocks WHERE blocked_id = :id', { id });
        const [history] = await pool.execute(
          `SELECT l.created_at, l.action_type, l.description, COALESCE(a.name, 'Automatic') AS by_name
           FROM admin_activity_logs l LEFT JOIN users a ON a.user_id = l.admin_id
           WHERE l.target_entity = 'users' AND l.target_entity_id = :id AND l.action_type != 'view_user'
           ORDER BY l.created_at DESC, l.log_id DESC LIMIT 30`, { id }
        );

        await logAdminAction(req.user.userId, 'view_user', 'users', id, `Viewed the details of ${u.name}`, u.name);
        res.json({
          account: {
            user_id: u.user_id, name: u.name, email: u.email, status: u.status, role,
            created_at: u.created_at, last_login_at: u.last_login_at, onboarded: Boolean(u.onboarded_at),
            department: u.department, city: u.city, country: u.country, staff_number: u.staff_number,
            two_factor: Boolean(u.totp_enabled), google_linked: Boolean(Number(u.google_linked))
          },
          hr: u.employment_status ? {
            name: u.hr_name, department: u.hr_department, employment_status: u.employment_status,
            alumni_eligible: Boolean(u.alumni_eligible), name_matches: String(u.hr_name || '').trim().toLowerCase() === String(u.name || '').trim().toLowerCase()
          } : null,
          profile: { headline: u.headline, skills: u.skills, career_interests: u.career_interests },
          mentor_stats: mentorStats,
          mentorships: mentorships.map((m) => ({
            ...m, goals_total: Number(m.goals_total), goals_done: Number(m.goals_done), meetings: Number(m.meetings),
            felt_safe: m.felt_safe === null ? null : Boolean(m.felt_safe)
          })),
          posts,
          reports_about: reportsAbout,
          reports_made: Number(reportsMade),
          blocked_by: Number(blockedBy),
          history
        });
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
        const [rows] = await pool.query('SELECT e.*, (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.event_id) AS attendee_count FROM events e ORDER BY e.event_date DESC');
        res.json(rows);
    } catch (err) { next(err); }
}

async function createEvent(req, res, next) {
  try {
    const error = validateEventInput(req.body);
    if (error) return res.status(400).json({ error });

    const { title, eventDate, description, mode, location, capacity } = req.body;
    const target = await require('./events.controller').cleanTargeting(req.body);
    if (target.error) return res.status(400).json({ error: target.error });
    const [result] = await pool.execute(
      `INSERT INTO events (title, event_date, description, topics, audience_departments, mode, location, capacity, created_by, status, reviewed_at)
       VALUES (:title, :eventDate, :description, :topics, :audience, :mode, :location, :capacity, :userId, 'approved', NOW())`,
      {
        title: title.trim(),
        eventDate,
        description: description || null,
        topics: target.topics,
        audience: target.audience,
        mode,
        location: location.trim(),
        capacity: capacity ? Number(capacity) : null,
        userId: req.user.userId
      }
    );

    await logAdminAction(req.user.userId, 'create_event', 'events', result.insertId, `Created event "${title.trim()}"`, title.trim());
    require('../utils/alerts').queueAlerts('event', result.insertId);

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

// Kept for older screens; every decision goes through smart moderation
async function reviewEvent(req, res, next) {
  try {
    const { applyDecision } = require('./moderation.controller');
    const { decision, reason } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approved or rejected' });
    }
    const result = await applyDecision({ kind: 'event', id: req.params.id, decision, reason, note: String(req.body.note || '').trim().slice(0, 255), adminId: req.user.userId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ message: `Event ${decision}` });
  } catch (err) {
    next(err);
  }
}

// The alumni office edits an event (fixing a typo, a new venue); registered people are told
async function updateEvent(req, res, next) {
    try {
        const { saveEventEdit } = require('./events.controller');
        const r = await saveEventEdit({ id: Number(req.params.id), body: req.body, userId: req.user.userId, isAdmin: true });
        if (r.error) return res.status(r.status).json({ error: r.error });
        await logAdminAction(req.user.userId, 'edit_event', 'events', req.params.id, `Edited event "${String(req.body.title || '').trim()}"`, String(req.body.title || '').trim());
        res.json(r.body);
    } catch (err) { next(err); }
}

// Kept for older screens: "deleting" an event now cancels it, so the record,
// its registrations and the reason stay as evidence instead of being erased
async function deleteEvent(req, res, next) {
    req.body = { reason: (req.body && req.body.reason) || null };
    return require('./events.controller').cancelEvent(req, res, next);
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
        const { applyDecision } = require('./moderation.controller');
        const { decision, reason } = req.body;
        if (!['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
        }
        const note = String(req.body.note || req.body.reviewNotes || '').trim().slice(0, 255);
        const result = await applyDecision({ kind: 'opportunity', id: req.params.id, decision, reason, note, adminId: req.user.userId });
        if (result.error) return res.status(result.status).json({ error: result.error });
        res.json({ opportunity_id: Number(req.params.id), status: decision });
    } catch (err) { next(err); }
}

/*
 * The activity log with filters: who did it (an admin or "Automatic"), the
 * kind of action, a date range and words in the description. 50 a page, or
 * the whole filtered list as CSV for an audit. Looking at a member's details
 * is logged too, but hidden unless asked for, so the log stays readable.
 */
const LOG_PAGE = 50;
async function listActivityLogs(req, res, next) {
    try {
        const q = req.query || {};
        const where = [];
        const params = [];
        if (q.by === 'automatic') where.push('l.admin_id IS NULL');
        else if (q.by && /^\d+$/.test(String(q.by))) { where.push('l.admin_id = ?'); params.push(Number(q.by)); }
        if (q.action) { where.push('l.action_type = ?'); params.push(String(q.action).slice(0, 50)); }
        else if (q.views !== '1') where.push("l.action_type != 'view_user'");
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.from || ''))) { where.push('l.created_at >= ?'); params.push(`${q.from} 00:00:00`); }
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ''))) { where.push('l.created_at <= ?'); params.push(`${q.to} 23:59:59`); }
        if (q.q && String(q.q).trim()) {
          where.push('(l.description LIKE ? OR l.target_label LIKE ?)');
          const like = `%${String(q.q).trim().slice(0, 100).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
          params.push(like, like);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const base = `FROM admin_activity_logs l LEFT JOIN users u ON u.user_id = l.admin_id ${whereSql}`;

        if (q.format === 'csv') {
          const [rows] = await pool.query(
            `SELECT l.created_at, COALESCE(u.name, 'Automatic') AS by_name, l.action_type, l.target_entity, l.target_entity_id, l.description
             ${base} ORDER BY l.created_at DESC, l.log_id DESC LIMIT 10000`, params
          );
          const cell = (v) => {
            const text = v instanceof Date ? v.toISOString() : String(v ?? '');
            // A leading = + - @ would run as a formula in Excel, so it is made plain text
            return `"${(/^[=+\-@]/.test(text) ? "'" + text : text).replace(/"/g, '""')}"`;
          };
          const csv = [['time', 'by', 'action', 'target', 'target_id', 'description'].join(',')]
            .concat(rows.map((r) => [r.created_at, r.by_name, r.action_type, r.target_entity, r.target_entity_id, r.description].map(cell).join(',')))
            .join('\r\n');
          await logAdminAction(req.user.userId, 'export_logs', 'admin_activity_logs', 0, `Exported ${rows.length} activity log entries`, 'Activity log');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', 'attachment; filename="alumnet-activity-log.csv"');
          return res.send(csv);
        }

        const page = Math.max(1, Number(q.page) || 1);
        const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);
        const [rows] = await pool.query(
          `SELECT l.*, COALESCE(u.name, 'Automatic') AS admin_name ${base}
           ORDER BY l.created_at DESC, l.log_id DESC LIMIT ${LOG_PAGE} OFFSET ${(page - 1) * LOG_PAGE}`, params
        );
        const [admins] = await pool.query(
          'SELECT DISTINCT u.user_id AS id, u.name FROM admin_activity_logs l JOIN users u ON u.user_id = l.admin_id ORDER BY u.name'
        );
        const [actions] = await pool.query('SELECT DISTINCT action_type FROM admin_activity_logs ORDER BY action_type');
        res.json({
          items: rows, total: Number(total), page, pages: Math.max(1, Math.ceil(Number(total) / LOG_PAGE)),
          admins, actions: actions.map((a2) => a2.action_type)
        });
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
              staff, email: request.email, passwordHash: request.password_hash,
              privacyAcceptedAt: request.privacy_accepted_at, privacyVersion: request.privacy_version
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

async function applyHrRows(rows, adminId, note = '') {
        const diff = await diffHr(rows);
        if (diff.error) return { status: 400, error: diff.error };
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
        await logAdminAction(adminId, 'import_hr', 'staff_directory', 0, `Imported HR update: ${summary}${note}`, 'HR records');
        return { status: 200, body: { ...result, summary } };
}

const activeAdmins = async () => (await pool.query(
  "SELECT u.user_id FROM admins a JOIN users u ON u.user_id = a.user_id WHERE u.status = 'active'"
))[0].map((r) => r.user_id);

/*
 * An HR import decides who can sign in and who becomes a mentor, so one
 * person should not be able to do it alone. With two or more admins, the
 * import waits for a different admin to approve it (the "four eyes" rule).
 * With a single admin there is nobody to ask, so it applies and the log
 * says no second check was possible.
 */
async function applyHrImport(req, res, next) {
    try {
        const diff = await diffHr(req.body.rows);
        if (diff.error) return res.status(400).json({ error: diff.error });
        const admins = await activeAdmins();
        const r = diff.result;
        const summary = `${r.added.length} new, ${r.updated.length} updated, ${r.retiring.length} now former staff, ${r.invalid.length} skipped`;
        if (admins.length >= 2) {
            const [ins] = await pool.execute(
              'INSERT INTO hr_import_requests (requested_by, rows_json, summary) VALUES (:by, :rows, :summary)',
              { by: req.user.userId, rows: JSON.stringify(req.body.rows), summary }
            );
            await logAdminAction(req.user.userId, 'request_hr_import', 'hr_import_requests', ins.insertId, `Asked for a second admin to approve an HR update: ${summary}`, 'HR records');
            await notifyMany(admins.filter((id) => id !== req.user.userId), 'hr_import_waiting',
              `An HR update (${summary}) is waiting for a second admin to approve it.`, 'admin.html#hr');
            return res.status(202).json({ waitingForSecondAdmin: true, requestId: ins.insertId, summary });
        }
        const out = await applyHrRows(req.body.rows, req.user.userId, ' (only one admin, so no second check was possible)');
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json(out.body);
    } catch (err) { next(err); }
}

async function listHrImportRequests(req, res, next) {
    try {
        const [rows] = await pool.query(
          `SELECT r.request_id, r.summary, r.created_at, r.requested_by, u.name AS requested_by_name
           FROM hr_import_requests r JOIN users u ON u.user_id = r.requested_by
           WHERE r.status = 'waiting' ORDER BY r.created_at`
        );
        res.json(rows.map((r) => ({ ...r, mine: r.requested_by === req.user.userId })));
    } catch (err) { next(err); }
}

async function decideHrImport(req, res, next) {
    try {
        const id = Number(req.params.id);
        const decision = req.body.decision;
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject' });
        const [[request]] = await pool.execute("SELECT * FROM hr_import_requests WHERE request_id = :id AND status = 'waiting'", { id });
        if (!request) return res.status(404).json({ error: 'This HR update is not waiting any more' });
        if (request.requested_by === req.user.userId) return res.status(403).json({ error: 'A different admin must approve an HR update you uploaded' });
        // Claim it first, so two admins cannot both apply it
        const [claim] = await pool.execute(
          "UPDATE hr_import_requests SET status = :state, decided_by = :by, decided_at = NOW() WHERE request_id = :id AND status = 'waiting'",
          { state: decision === 'approve' ? 'applied' : 'rejected', by: req.user.userId, id }
        );
        if (!claim.affectedRows) return res.status(409).json({ error: 'Another admin has just decided this' });
        await createNotification(request.requested_by, 'hr_import_decided',
          `Your HR update (${request.summary}) was ${decision === 'approve' ? 'approved and applied' : 'rejected'}.`, 'admin.html#hr');
        if (decision === 'reject') {
            await logAdminAction(req.user.userId, 'reject_hr_import', 'hr_import_requests', id, `Rejected an HR update: ${request.summary}`, 'HR records');
            return res.json({ message: 'Rejected. Nothing was changed.' });
        }
        const out = await applyHrRows(JSON.parse(request.rows_json), req.user.userId, ' (second admin approval)');
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json(out.body);
    } catch (err) { next(err); }
}

module.exports = {
  logAdminAction,
  getStats, listUsers, getUserDetail, toggleUserStatus,
  listSignupRequests, reviewSignupRequest,
  previewHrImport, applyHrImport,
  listEvents, createEvent, updateEvent, deleteEvent, listHrImportRequests, decideHrImport,
  listPendingEvents, reviewEvent,
  listPendingOpportunities, reviewOpportunity,
  listActivityLogs
};