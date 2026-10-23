const pool = require('../config/db');
const { createNotification } = require('./notify');

/*
 * The HR record (staff_directory) is the source of truth for who someone is
 * and which role they have:
 *   active staff  -> mentee
 *   former staff  -> mentor (if eligible for the alumni network)
 */

function normaliseStaffNumber(value) {
  return String(value || '').trim().toUpperCase();
}

function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function findStaff(staffNumber, conn = pool) {
  const [[staff]] = await conn.execute(
    'SELECT * FROM staff_directory WHERE staff_number = :staffNumber',
    { staffNumber }
  );
  return staff || null;
}

// The email HR holds for verification: work email for current staff,
// personal email for former staff
function hrEmailFor(staff) {
  if (!staff) return null;
  const email = staff.employment_status === 'active' ? staff.kq_email : staff.personal_email;
  return email ? normaliseEmail(email) : null;
}

function roleForStaff(staff) {
  if (!staff) return null;
  return staff.employment_status === 'former' ? 'mentor' : 'mentee';
}

function canJoin(staff) {
  return Boolean(staff) && Boolean(staff.alumni_eligible);
}

// End open mentorships for one side of a user's account, telling the other person
async function endOpenMentorships(conn, userId, side, reason) {
  const column = side === 'mentee' ? 'mentee_id' : 'mentor_id';
  const other = side === 'mentee' ? 'mentor_id' : 'mentee_id';
  const [rows] = await conn.execute(
    `SELECT request_id, status, ${other} AS other_id FROM mentorship_requests
     WHERE ${column} = :userId AND status IN ('pending','accepted')`,
    { userId }
  );
  for (const r of rows) {
    await conn.execute(
      `UPDATE mentorship_requests
       SET status = :status, ended_at = NOW(), ended_by = :userId
       WHERE request_id = :id`,
      { status: r.status === 'accepted' ? 'ended' : 'declined', userId, id: r.request_id }
    );
  }
  return rows.map((r) => ({ otherId: r.other_id, wasAccepted: r.status === 'accepted', reason }));
}

/*
 * Works out a user's role from HR and keeps the mentee/mentor tables in
 * step. When someone retires, their account becomes a mentor account: open
 * mentorships they had as a mentee are ended politely and history is kept.
 */
async function resolveRole(userId) {
  const [[u]] = await pool.execute(
    `SELECT u.user_id, u.name, u.staff_number, u.department, sd.department AS hr_department, sd.employment_status, sd.alumni_eligible,
            ad.user_id AS is_admin, me.user_id AS is_mentee, mo.user_id AS is_mentor
     FROM users u
     LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
     LEFT JOIN admins ad ON ad.user_id = u.user_id
     LEFT JOIN mentees me ON me.user_id = u.user_id
     LEFT JOIN mentors mo ON mo.user_id = u.user_id
     WHERE u.user_id = :userId`,
    { userId }
  );
  if (!u) return null;
  // HR is the source of truth for the department too, even if the record was fixed by hand
  if (u.hr_department && u.hr_department !== u.department) {
    await pool.execute('UPDATE users SET department = :d WHERE user_id = :userId', { d: u.hr_department, userId });
  }
  if (u.is_admin) return 'admin';

  // Accounts not linked to an HR record (older demo data) keep their table role
  if (!u.employment_status) return u.is_mentor ? 'mentor' : u.is_mentee ? 'mentee' : null;

  const role = u.employment_status === 'former' ? 'mentor' : 'mentee';
  // Rows in mentees/mentors are kept as history, so only a missing row means a change
  const changing = role === 'mentor' ? !u.is_mentor : !u.is_mentee;
  if (!changing) return role;

  const conn = await pool.getConnection();
  let ended = [];
  try {
    await conn.beginTransaction();
    if (role === 'mentor') {
      await conn.execute('INSERT IGNORE INTO mentors (user_id) VALUES (:userId)', { userId });
      if (u.is_mentee) ended = await endOpenMentorships(conn, userId, 'mentee', 'retired');
    } else {
      await conn.execute('INSERT IGNORE INTO mentees (user_id) VALUES (:userId)', { userId });
      if (u.is_mentor) ended = await endOpenMentorships(conn, userId, 'mentor', 'rejoined');
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // Only an existing account changing role gets the messages, not a brand-new one
  if (u.is_mentee || u.is_mentor) {
    for (const e of ended) {
      await createNotification(
        e.otherId,
        'mentorship_ended',
        role === 'mentor'
          ? `${u.name} has left Kenya Airways, so your mentorship request with them has closed.`
          : `${u.name} has rejoined Kenya Airways as staff, so your mentorship with them has closed.`,
        'requests.html'
      );
    }
    await createNotification(
      userId,
      'role_changed',
      role === 'mentor'
        ? 'Welcome to the mentor community. Update your profile so the right mentees can find you.'
        : 'Welcome back to Kenya Airways. Your account is now a mentee account.',
      'profile.html#edit'
    );
  }
  return role;
}

module.exports = { normaliseStaffNumber, normaliseEmail, findStaff, hrEmailFor, roleForStaff, canJoin, resolveRole, endOpenMentorships };
