/*
 * Impact for the alumni office: is the network doing what it is for?
 * Mentorship from request to outcome, how evenly mentees are spread across
 * mentors, events and opportunities. Every figure is computed here from the
 * database, for a chosen period, so it can go straight into a report.
 *
 * Small numbers are reported as they are, with the count beside each rate,
 * so "100% accepted" from one request is never mistaken for a trend.
 */
const pool = require('../config/db');

const PERIODS = { 30: 30, 90: 90, 365: 365, all: null };

const pct = (part, whole) => (Number(whole) ? Math.round((Number(part) / Number(whole)) * 1000) / 10 : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

// Gini coefficient: 0 when every mentor gets the same number of requests, near 1
// when a few mentors get nearly all of them
function gini(values) {
  const xs = values.map(Number).filter((v) => v >= 0).sort((a, b) => a - b);
  const n = xs.length;
  const total = xs.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let weighted = 0;
  xs.forEach((x, i) => { weighted += (i + 1) * x; });
  return Math.round(((2 * weighted) / (n * total) - (n + 1) / n) * 100) / 100;
}

function median(values) {
  const xs = values.map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

async function getImpact(req, res, next) {
  try {
    const key = String(req.query.period || '90');
    if (!(key in PERIODS)) return res.status(400).json({ error: 'Choose a period of 30, 90 or 365 days, or all' });
    const days = PERIODS[key];
    // The same "since" condition for every table, as a parameter
    const since = (col) => (days ? `${col} >= DATE_SUB(NOW(), INTERVAL ${Number(days)} DAY)` : '1 = 1');

    /* ---------- Mentorship: request to outcome ---------- */
    const [[req1]] = await pool.query(
      `SELECT COUNT(*) AS sent,
              SUM(status IN ('accepted','ended')) AS accepted,
              SUM(status = 'declined') AS declined,
              SUM(status = 'expired') AS expired,
              SUM(status = 'pending') AS pending,
              SUM(status = 'withdrawn') AS withdrawn
       FROM mentorship_requests WHERE ${since('requested_at')}`
    );
    const [replyRows] = await pool.query(
      `SELECT TIMESTAMPDIFF(MINUTE, requested_at, responded_at) / 60 AS hours FROM mentorship_requests
       WHERE responded_at IS NOT NULL AND status IN ('accepted','ended','declined') AND ${since('requested_at')}`
    );
    const [[active]] = await pool.query("SELECT COUNT(*) AS n FROM mentorship_requests WHERE status = 'accepted'");
    const [[progress]] = await pool.query(
      `SELECT COUNT(*) AS started,
              SUM(EXISTS(SELECT 1 FROM mentorship_meetings m WHERE m.request_id = r.request_id)) AS with_meeting,
              SUM(EXISTS(SELECT 1 FROM mentorship_goals g WHERE g.request_id = r.request_id)) AS with_goals,
              AVG((SELECT COUNT(*) FROM mentorship_meetings m WHERE m.request_id = r.request_id)) AS avg_meetings
       FROM mentorship_requests r WHERE r.status IN ('accepted','ended') AND ${since('r.requested_at')}`
    );
    const [[goals]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(g.done_at IS NOT NULL) AS done FROM mentorship_goals g
       JOIN mentorship_requests r ON r.request_id = g.request_id WHERE ${since('r.requested_at')}`
    );

    /* ---------- Outcomes: private feedback after a mentorship ends ---------- */
    const [[ended]] = await pool.query(`SELECT COUNT(*) AS n FROM mentorship_requests WHERE status = 'ended' AND ${since('ended_at')}`);
    const [fbRows] = await pool.query(
      `SELECT f.side, f.met, f.helpful, f.goals_progress, f.felt_safe FROM mentorship_feedback f
       JOIN mentorship_requests r ON r.request_id = f.request_id WHERE ${since('r.ended_at')}`
    );
    const mentee = fbRows.filter((f) => f.side === 'mentee');
    const helpfulScores = fbRows.filter((f) => f.helpful !== null).map((f) => f.helpful);
    const progressCounts = { none: 0, some: 0, most: 0, all: 0 };
    mentee.forEach((f) => { if (f.goals_progress) progressCounts[f.goals_progress] += 1; });
    const ratingCounts = [1, 2, 3, 4, 5].map((n) => helpfulScores.filter((h) => Number(h) === n).length);
    // Mentees and mentors are asked the same question about different things
    // (being helped versus helping), so their answers are kept apart
    const bySide = (side) => {
      const scores = fbRows.filter((f) => f.side === side && f.helpful !== null).map((f) => Number(f.helpful));
      return {
        answers: fbRows.filter((f) => f.side === side).length,
        rated: scores.length,
        avg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
        counts: [1, 2, 3, 4, 5].map((n) => scores.filter((h) => h === n).length)
      };
    };

    /* ---------- Fairness: are requests spread across mentors? ---------- */
    const [perMentor] = await pool.query(
      `SELECT mt.user_id,
              (SELECT COUNT(*) FROM mentorship_requests r WHERE r.mentor_id = mt.user_id AND ${since('r.requested_at')}) AS requests,
              (SELECT COUNT(*) FROM mentorship_requests r WHERE r.mentor_id = mt.user_id AND r.status = 'accepted') AS active
       FROM mentors mt JOIN users u ON u.user_id = mt.user_id
       LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
       WHERE u.status = 'active' AND (sd.staff_number IS NULL OR sd.employment_status = 'former')`
    );
    const requestCounts = perMentor.map((m) => Number(m.requests));
    const sortedDesc = [...requestCounts].sort((a, b) => b - a);
    const totalRequests = requestCounts.reduce((a, b) => a + b, 0);
    const topFifth = Math.max(1, Math.ceil(perMentor.length / 5));
    const activeDist = { 0: 0, 1: 0, 2: 0, '3+': 0 };
    perMentor.forEach((m) => { const n = Number(m.active); activeDist[n >= 3 ? '3+' : n] += 1; });

    /* ---------- Events ---------- */
    const [[ev]] = await pool.query(
      `SELECT COUNT(*) AS held,
              SUM(capacity IS NOT NULL) AS with_capacity,
              AVG(IF(capacity IS NOT NULL AND capacity > 0, (SELECT COUNT(*) FROM event_registrations r WHERE r.event_id = e.event_id) / capacity, NULL)) AS fill
       FROM events e WHERE e.status = 'approved' AND e.event_date < NOW() AND ${since('e.event_date')}`
    );
    const [[evUpcoming]] = await pool.query("SELECT COUNT(*) AS n FROM events WHERE status = 'approved' AND event_date >= NOW()");
    const [[regs]] = await pool.query(`SELECT COUNT(*) AS n FROM event_registrations WHERE ${since('registered_at')}`);
    const [[cancelled]] = await pool.query(`SELECT COUNT(*) AS n FROM events WHERE status = 'cancelled' AND ${since('COALESCE(edited_at, event_date)')}`);

    /* ---------- Opportunities and moderation ---------- */
    const [[op]] = await pool.query(
      `SELECT COUNT(*) AS submitted,
              SUM(approval_status = 'approved') AS approved,
              SUM(approval_status = 'rejected') AS rejected,
              SUM(rejection_reason = 'asks_for_payment') AS scams,
              SUM(auto_approved = 1) AS auto_approved
       FROM career_opportunities WHERE ${since('COALESCE(submitted_at, created_at)')}`
    );
    const [reviewRows] = await pool.query(
      `SELECT TIMESTAMPDIFF(MINUTE, submitted_at, reviewed_at) / 60 AS hours FROM career_opportunities
       WHERE submitted_at IS NOT NULL AND reviewed_at IS NOT NULL AND auto_approved = 0 AND ${since('submitted_at')}`
    );
    const [[alerts]] = await pool.query(`SELECT COUNT(*) AS n FROM alerts_sent WHERE ${since('sent_at')}`);

    /* ---------- Members ---------- */
    const [[members]] = await pool.query(
      `SELECT SUM(EXISTS(SELECT 1 FROM mentees m WHERE m.user_id = u.user_id) AND (sd.staff_number IS NULL OR sd.employment_status = 'active')) AS mentees,
              SUM(EXISTS(SELECT 1 FROM mentors m WHERE m.user_id = u.user_id) AND (sd.staff_number IS NULL OR sd.employment_status = 'former')) AS mentors,
              SUM(${since('u.created_at')}) AS joined,
              SUM(u.totp_enabled = 1) AS two_factor,
              COUNT(*) AS total
       FROM users u LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
       WHERE u.status = 'active' AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.user_id = u.user_id)`
    );

    /* ---------- Requests per month, last 12 months ---------- */
    const [monthly] = await pool.query(
      `SELECT DATE_FORMAT(requested_at, '%Y-%m') AS month, COUNT(*) AS sent, SUM(status IN ('accepted','ended')) AS accepted
       FROM mentorship_requests WHERE requested_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 11 MONTH)
       GROUP BY month ORDER BY month`
    );
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const k = d.toISOString().slice(0, 7);
      const hit = monthly.find((m) => m.month === k);
      months.push({ month: k, sent: hit ? Number(hit.sent) : 0, accepted: hit ? Number(hit.accepted || 0) : 0 });
    }

    res.json({
      period: key,
      generated_at: new Date().toISOString(),
      mentorship: {
        requests_sent: Number(req1.sent),
        accepted: Number(req1.accepted || 0), declined: Number(req1.declined || 0), expired: Number(req1.expired || 0),
        pending: Number(req1.pending || 0), withdrawn: Number(req1.withdrawn || 0),
        acceptance_rate: pct(req1.accepted, Number(req1.sent) - Number(req1.pending || 0) - Number(req1.withdrawn || 0)),
        median_reply_hours: median(replyRows.map((r) => r.hours)) === null ? null : Math.round(median(replyRows.map((r) => r.hours)) * 10) / 10,
        replies_measured: replyRows.length,
        active_now: Number(active.n),
        started: Number(progress.started),
        with_meeting_rate: pct(progress.with_meeting, progress.started),
        with_goals_rate: pct(progress.with_goals, progress.started),
        avg_meetings: progress.avg_meetings === null ? null : Math.round(Number(progress.avg_meetings) * 10) / 10,
        goals_total: Number(goals.total), goals_done: Number(goals.done || 0), goals_done_rate: pct(goals.done, goals.total)
      },
      outcomes: {
        ended: Number(ended.n),
        answers: fbRows.length,
        // Each ended mentorship can get two answers, one from each person
        response_rate: pct(fbRows.length, Number(ended.n) * 2),
        met_rate: pct(fbRows.filter((f) => f.met).length, fbRows.length),
        avg_helpful: helpfulScores.length ? Math.round((helpfulScores.reduce((a, b) => a + Number(b), 0) / helpfulScores.length) * 10) / 10 : null,
        avg_helpful_mentees: mentee.filter((f) => f.helpful !== null).length
          ? Math.round((mentee.filter((f) => f.helpful !== null).reduce((a, f) => a + Number(f.helpful), 0) / mentee.filter((f) => f.helpful !== null).length) * 10) / 10 : null,
        rating_counts: ratingCounts,
        helpful_by_side: { mentee: bySide('mentee'), mentor: bySide('mentor') },
        goals_progress: progressCounts,
        felt_unsafe: fbRows.filter((f) => !f.felt_safe).length
      },
      fairness: {
        mentors: perMentor.length,
        requests: totalRequests,
        gini: gini(requestCounts),
        top_fifth_share: totalRequests ? pct(sortedDesc.slice(0, topFifth).reduce((a, b) => a + b, 0), totalRequests) : null,
        top_fifth_count: topFifth,
        mentors_without_requests: requestCounts.filter((n) => n === 0).length,
        active_mentees_per_mentor: activeDist
      },
      events: {
        held: Number(ev.held), upcoming: Number(evUpcoming.n), registrations: Number(regs.n), cancelled: Number(cancelled.n),
        avg_fill_rate: ev.fill === null ? null : Math.round(Number(ev.fill) * 1000) / 10
      },
      opportunities: {
        submitted: Number(op.submitted), approved: Number(op.approved || 0), rejected: Number(op.rejected || 0),
        scams_stopped: Number(op.scams || 0), auto_approved: Number(op.auto_approved || 0),
        median_review_hours: median(reviewRows.map((r) => r.hours)) === null ? null : Math.round(median(reviewRows.map((r) => r.hours)) * 10) / 10,
        alerts_sent: Number(alerts.n)
      },
      members: {
        mentees: Number(members.mentees || 0), mentors: Number(members.mentors || 0), joined: Number(members.joined || 0),
        two_factor_rate: pct(members.two_factor, members.total)
      },
      monthly: months
    });
  } catch (err) { next(err); }
}

module.exports = { getImpact, gini, median };
