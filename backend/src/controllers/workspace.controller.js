/*
 * The shared space for an accepted mentorship: goals the pair agrees, a log
 * of meetings, and private feedback from each person once it ends. This is
 * what lets AlumNet show that matches turn into useful mentorships, not just
 * accepted requests.
 */
const pool = require('../config/db');
const { createNotification } = require('../utils/notify');

const LIMITS = { goals: 8, goalText: 200, note: 500, comment: 500, minMinutes: 5, maxMinutes: 480 };
const MODES = ['in_person', 'virtual', 'phone'];
const PROGRESS = ['none', 'some', 'most', 'all'];

// The mentorship, if the signed-in person is one of the two people in it
async function mentorshipFor(req) {
  const [[m]] = await pool.execute(
    `SELECT r.*, IF(r.mentee_id = :me, 'mentee', 'mentor') AS my_side,
            IF(r.mentee_id = :me, r.mentor_id, r.mentee_id) AS other_id
     FROM mentorship_requests r
     WHERE r.request_id = :id AND (r.mentee_id = :me OR r.mentor_id = :me)`,
    { id: Number(req.params.id), me: req.user.userId }
  );
  return m || null;
}

async function getWorkspace(req, res, next) {
  try {
    const m = await mentorshipFor(req);
    if (!m) return res.status(404).json({ error: 'Mentorship not found' });
    if (!['accepted', 'ended'].includes(m.status)) return res.status(409).json({ error: 'This request was not accepted' });
    const [goals] = await pool.execute(
      `SELECT g.goal_id, g.text, g.done_at, g.created_at, g.created_by = :me AS mine, u.name AS added_by
       FROM mentorship_goals g LEFT JOIN users u ON u.user_id = g.created_by
       WHERE g.request_id = :id ORDER BY g.created_at`, { id: m.request_id, me: req.user.userId }
    );
    const [meetings] = await pool.execute(
      `SELECT mt.meeting_id, DATE_FORMAT(mt.met_on, '%Y-%m-%d') AS met_on, mt.mode, mt.minutes, mt.note,
              mt.logged_by = :me AS mine, u.name AS logged_by_name
       FROM mentorship_meetings mt LEFT JOIN users u ON u.user_id = mt.logged_by
       WHERE mt.request_id = :id ORDER BY mt.met_on DESC, mt.meeting_id DESC`, { id: m.request_id, me: req.user.userId }
    );
    const [[mine]] = await pool.execute('SELECT created_at FROM mentorship_feedback WHERE request_id = :id AND user_id = :me', { id: m.request_id, me: req.user.userId });
    res.json({
      request_id: m.request_id,
      status: m.status,
      my_side: m.my_side,
      started_at: m.responded_at,
      ended_at: m.ended_at,
      editable: m.status === 'accepted',
      goals: goals.map((g) => ({ ...g, mine: Number(g.mine) === 1, done: Boolean(g.done_at) })),
      meetings: meetings.map((x) => ({ ...x, mine: Number(x.mine) === 1 })),
      feedback_given: Boolean(mine),
      can_give_feedback: m.status === 'ended' && !mine
    });
  } catch (err) { next(err); }
}

async function addGoal(req, res, next) {
  try {
    const m = await mentorshipFor(req);
    if (!m) return res.status(404).json({ error: 'Mentorship not found' });
    if (m.status !== 'accepted') return res.status(409).json({ error: 'Goals can only be added while the mentorship is active' });
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'Write the goal first' });
    if (text.length > LIMITS.goalText) return res.status(400).json({ error: `Keep a goal under ${LIMITS.goalText} characters` });
    const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM mentorship_goals WHERE request_id = :id', { id: m.request_id });
    if (Number(n) >= LIMITS.goals) return res.status(409).json({ error: `A mentorship can have up to ${LIMITS.goals} goals. Remove one first.` });
    const [r] = await pool.execute('INSERT INTO mentorship_goals (request_id, text, created_by) VALUES (:id, :text, :me)', { id: m.request_id, text, me: req.user.userId });
    if (Number(n) === 0) {
      await createNotification(m.other_id, 'mentorship_goal', 'The first goal for your mentorship was added. Open the mentorship to see it.', 'requests.html');
    }
    res.status(201).json({ goal_id: r.insertId });
  } catch (err) { next(err); }
}

async function updateGoal(req, res, next) {
  try {
    const m = await mentorshipFor(req);
    if (!m) return res.status(404).json({ error: 'Mentorship not found' });
    if (m.status !== 'accepted') return res.status(409).json({ error: 'This mentorship has ended' });
    const done = (req.body || {}).done === true;
    const [r] = await pool.execute(
      'UPDATE mentorship_goals SET done_at = IF(:done, COALESCE(done_at, NOW()), NULL) WHERE goal_id = :goal AND request_id = :id',
      { done: done ? 1 : 0, goal: Number(req.params.goalId), id: m.request_id }
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Goal not found' });
    res.json({ done });
  } catch (err) { next(err); }
}

async function deleteGoal(req, res, next) {
  try {
    const m = await mentorshipFor(req);
    if (!m) return res.status(404).json({ error: 'Mentorship not found' });
    if (m.status !== 'accepted') return res.status(409).json({ error: 'This mentorship has ended' });
    // Only the person who added a goal removes it, so nobody erases the other's goals
    const [r] = await pool.execute('DELETE FROM mentorship_goals WHERE goal_id = :goal AND request_id = :id AND created_by = :me',
      { goal: Number(req.params.goalId), id: m.request_id, me: req.user.userId });
    if (!r.affectedRows) return res.status(404).json({ error: 'You can only remove goals you added' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
}

async function logMeeting(req, res, next) {
  try {
    const m = await mentorshipFor(req);
    if (!m) return res.status(404).json({ error: 'Mentorship not found' });
    if (m.status !== 'accepted') return res.status(409).json({ error: 'Meetings can only be logged while the mentorship is active' });
    const { metOn, mode } = req.body || {};
    const minutes = Number((req.body || {}).minutes);
    const note = String((req.body || {}).note || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(metOn || ''))) return res.status(400).json({ error: 'Choose the date you met' });
    // Dates are compared as Nairobi calendar days ("2026-10-23"), whatever the server's time zone
    const nairobiDay = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Africa/Nairobi' });
    if (isNaN(new Date(metOn)) || metOn > nairobiDay(Date.now())) return res.status(400).json({ error: 'The meeting date cannot be in the future' });
    if (m.responded_at && metOn < nairobiDay(m.responded_at)) {
      return res.status(400).json({ error: 'The meeting date is before the mentorship started' });
    }
    if (!MODES.includes(mode)) return res.status(400).json({ error: 'Choose how you met' });
    if (!Number.isInteger(minutes) || minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes) {
      return res.status(400).json({ error: `Length must be between ${LIMITS.minMinutes} and ${LIMITS.maxMinutes} minutes` });
    }
    if (note.length > LIMITS.note) return res.status(400).json({ error: `Keep the note under ${LIMITS.note} characters` });
    const [r] = await pool.execute(
      'INSERT INTO mentorship_meetings (request_id, met_on, mode, minutes, note, logged_by) VALUES (:id, :metOn, :mode, :minutes, :note, :me)',
      { id: m.request_id, metOn, mode, minutes, note: note || null, me: req.user.userId }
    );
    res.status(201).json({ meeting_id: r.insertId });
  } catch (err) { next(err); }
}

async function deleteMeeting(req, res, next) {
  try {
    const m = await mentorshipFor(req);
    if (!m) return res.status(404).json({ error: 'Mentorship not found' });
    if (m.status !== 'accepted') return res.status(409).json({ error: 'This mentorship has ended' });
    const [r] = await pool.execute('DELETE FROM mentorship_meetings WHERE meeting_id = :mid AND request_id = :id AND logged_by = :me',
      { mid: Number(req.params.meetingId), id: m.request_id, me: req.user.userId });
    if (!r.affectedRows) return res.status(404).json({ error: 'You can only remove meetings you logged' });
    res.json({ deleted: true });
  } catch (err) { next(err); }
}

/*
 * Private feedback after a mentorship ends. The other person never sees it.
 * "I did not feel safe" opens a report for the alumni office straight away.
 */
async function giveFeedback(req, res, next) {
  try {
    const m = await mentorshipFor(req);
    if (!m) return res.status(404).json({ error: 'Mentorship not found' });
    if (m.status !== 'ended') return res.status(409).json({ error: 'Feedback is asked for once a mentorship has ended' });
    const b = req.body || {};
    const met = b.met === true;
    const helpful = met ? Number(b.helpful) : null;
    const progress = met ? b.goalsProgress || null : null;
    const feltSafe = b.feltSafe !== false;
    const comment = String(b.comment || '').trim();
    if (typeof b.met !== 'boolean') return res.status(400).json({ error: 'Say whether you met' });
    if (met && !(Number.isInteger(helpful) && helpful >= 1 && helpful <= 5)) return res.status(400).json({ error: 'Choose how helpful it was, from 1 to 5' });
    if (progress && !PROGRESS.includes(progress)) return res.status(400).json({ error: 'Choose how many goals you reached' });
    if (comment.length > LIMITS.comment) return res.status(400).json({ error: `Keep the comment under ${LIMITS.comment} characters` });
    try {
      await pool.execute(
        `INSERT INTO mentorship_feedback (request_id, user_id, side, met, helpful, goals_progress, felt_safe, comment)
         VALUES (:id, :me, :side, :met, :helpful, :progress, :safe, :comment)`,
        { id: m.request_id, me: req.user.userId, side: m.my_side, met: met ? 1 : 0, helpful, progress, safe: feltSafe ? 1 : 0, comment: comment || null }
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'You have already given feedback for this mentorship' });
      throw err;
    }
    if (!feltSafe) {
      await pool.execute(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason, details)
         VALUES (:me, 'user', :other, 'harassment', :details)`,
        { me: req.user.userId, other: m.other_id, details: `From mentorship feedback: did not feel safe.${comment ? ' ' + comment : ''}`.slice(0, 500) }
      );
    }
    res.status(201).json({ message: feltSafe ? 'Thank you. Your answers go only to the alumni office.' : 'Thank you. The alumni office has been told you did not feel safe and will follow up.' });
  } catch (err) { next(err); }
}

module.exports = { getWorkspace, addGoal, updateGoal, deleteGoal, logMeeting, deleteMeeting, giveFeedback, LIMITS };
