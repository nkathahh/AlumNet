const pool = require('../config/db');
const { createNotification, getUserName } = require('../utils/notify');
const { isBlockedEitherWay, fileAutomaticReport, parseFlags } = require('./safety.controller');
const { scanText } = require('../utils/scam');

// A mentee can have this many requests waiting at once, so nobody sprays every mentor
const MAX_PENDING = 5;

async function createRequest(req, res, next) {
    try {
        const { userId, role } = req.user;
        if (role !== 'mentee') return res.status(403).json({ error: 'Only mentees can send mentorship requests' });

        const mentorId = Number(req.body.mentorId);
        if (!Number.isInteger(mentorId)) return res.status(400).json({ error: 'mentorId is required' });
        const message = String(req.body.message || '').trim();
        if (message.length > 500) return res.status(400).json({ error: 'Keep your message under 500 characters' });
        const scan = message ? scanText(message) : null;

        // Only active, eligible former staff can be asked
        const [[mentor]] = await pool.execute(
            `SELECT u.user_id, u.name, mt.accepting_mentees, mt.max_mentees,
                    (SELECT COUNT(*) FROM mentorship_requests r WHERE r.mentor_id = u.user_id AND r.status = 'accepted') AS active
             FROM mentors mt JOIN users u ON u.user_id = mt.user_id
             LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
             WHERE mt.user_id = :mentorId AND u.status = 'active'
               AND (sd.staff_number IS NULL OR (sd.employment_status = 'former' AND sd.alumni_eligible = 1))`,
            { mentorId }
        );
        if (!mentor) return res.status(404).json({ error: 'Mentor not found' });
        // Mentors choose whether they take mentees and how many at a time
        if (!mentor.accepting_mentees || Number(mentor.active) >= Number(mentor.max_mentees)) {
            return res.status(409).json({ error: `${mentor.name.split(' ')[0]} is not taking new mentees right now. Try another mentor, or check back later.` });
        }
        // Same reply whichever side blocked, so nobody learns they were blocked
        if (await isBlockedEitherWay(userId, mentorId)) {
            return res.status(403).json({ error: 'This mentor is not taking requests from you right now' });
        }

        const [[existing]] = await pool.execute(
            `SELECT request_id, status FROM mentorship_requests
            WHERE mentee_id = :userId AND mentor_id = :mentorId AND status IN ('pending','accepted')`,
            { userId, mentorId }
        );
        if (existing) {
            const message = existing.status === 'accepted'
                ? 'This mentor is already mentoring you'
                : 'You already have a pending request with this mentor';
            return res.status(409).json({ error: message });
        }

        await expireStaleRequests({ menteeId: userId });
        const [[recentDecline]] = await pool.execute(
            `SELECT 1 AS hit FROM mentorship_requests WHERE mentee_id = :userId AND mentor_id = :mentorId
             AND status = 'declined' AND COALESCE(responded_at, requested_at) > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
            { userId, mentorId }
        );
        if (recentDecline) {
            return res.status(409).json({ error: 'This mentor declined a request from you recently. You can ask again after 30 days.' });
        }

        // The limit check and the insert happen together, with the mentee's row
        // locked, so two quick clicks cannot both get past the limit
        const conn = await pool.getConnection();
        let result;
        try {
            await conn.beginTransaction();
            await conn.execute('SELECT user_id FROM mentees WHERE user_id = :userId FOR UPDATE', { userId });
            const [[{ pending }]] = await conn.execute(
                "SELECT COUNT(*) AS pending FROM mentorship_requests WHERE mentee_id = :userId AND status = 'pending'",
                { userId }
            );
            if (pending >= MAX_PENDING) {
                await conn.rollback();
                return res.status(409).json({ error: `You have ${MAX_PENDING} requests waiting. Wait for replies or withdraw one before asking someone new.` });
            }
            [result] = await conn.execute(
                `INSERT INTO mentorship_requests (mentee_id, mentor_id, status, message, risk_flags) VALUES (:userId, :mentorId, 'pending', :message, :flags)`,
                { userId, mentorId, message: message || null, flags: scan && scan.flags.length ? JSON.stringify(scan.flags) : null }
            );
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
        await fileAutomaticReport('user', userId, scan, 'a mentorship request message');

        // Tell the mentor they have a new request
        const menteeName = await getUserName(userId);
        await createNotification(
            mentorId,
            'mentorship_request',
            `${menteeName} sent you a mentorship request.`,
            'requests.html'
        );

        res.status(201).json({ request_id: result.insertId, status: 'pending' });
    } catch (err) {
        if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'Mentor not found' });
        next(err);
    }
}

/*
 * A request with no reply after 14 days expires and the mentee is told.
 * Runs when requests are listed or sent, and from the clean-up job.
 */
const EXPIRY_DAYS = 14;
async function expireStaleRequests({ menteeId = null, mentorId = null } = {}) {
    const [stale] = await pool.execute(
        `SELECT r.request_id, r.mentee_id, u.name AS mentor_name FROM mentorship_requests r
         JOIN users u ON u.user_id = r.mentor_id
         WHERE r.status = 'pending' AND r.requested_at < DATE_SUB(NOW(), INTERVAL ${EXPIRY_DAYS} DAY)
           AND (:menteeId IS NULL OR r.mentee_id = :menteeId) AND (:mentorId IS NULL OR r.mentor_id = :mentorId)`,
        { menteeId, mentorId }
    );
    for (const r of stale) {
        await pool.execute("UPDATE mentorship_requests SET status = 'expired', responded_at = NOW() WHERE request_id = :id AND status = 'pending'", { id: r.request_id });
        await createNotification(
            r.mentee_id, 'request_expired',
            `Your request to ${r.mentor_name} expired after ${EXPIRY_DAYS} days without a reply. You can ask another mentor.`,
            'recommendations.html'
        );
    }
    return stale.length;
}

// When a mentor becomes full or pauses, people waiting on them are told
async function tellWaitingMentees(mentorId, why) {
    const [rows] = await pool.execute(
        `SELECT r.mentee_id, u.name FROM mentorship_requests r JOIN users u ON u.user_id = r.mentor_id
         WHERE r.mentor_id = :mentorId AND r.status = 'pending'`,
        { mentorId }
    );
    for (const r of rows) {
        const first = r.name.split(' ')[0];
        await createNotification(
            r.mentee_id, 'mentor_unavailable',
            why === 'full'
                ? `${first} now has as many mentees as they can take, so your request may not be accepted. You can withdraw it and ask another mentor.`
                : `${first} has paused new mentorships, so your request may not be answered soon. You can withdraw it and ask another mentor.`,
            'requests.html'
        );
    }
}

async function listMyRequests(req, res, next) {
    try {
        const { userId, role } = req.user;
        await expireStaleRequests(role === 'mentor' ? { mentorId: userId } : { menteeId: userId });
        const column = role === 'mentor' ? 'mentor_id' : 'mentee_id';
        const otherColumn = role === 'mentor' ? 'mentee_id' : 'mentor_id';

        const [rows] = await pool.execute(
            `SELECT r.request_id, r.status, r.requested_at, r.responded_at, r.message, r.risk_flags,
                    u.user_id AS other_user_id, u.name AS other_name, u.department AS other_department,
                    u.email AS other_email, p.headline AS other_headline, sd.employment_status AS other_hr_status
   FROM mentorship_requests r
   JOIN users u ON u.user_id = r.${otherColumn}
   LEFT JOIN profiles p ON p.user_id = u.user_id
   LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
   WHERE r.${column} = :userId
   ORDER BY r.requested_at DESC`,
            { userId }
        );

        // Contact details are shared only once the mentor has accepted
        res.json(rows.map(({ other_email: email, other_hr_status: hr, risk_flags: flags, ...r }) => ({
            ...r,
            // Only the person receiving the message sees the caution
            message_warnings: role === 'mentor' ? parseFlags(flags).filter((f) => f.level !== 'low').map((f) => f.label) : [],
            other_verified: Boolean(hr),
            other_email: r.status === 'accepted' ? email : null
        })));
    } catch (err) { next(err); }
}

async function respondToRequest(req, res, next) {
    try {
        const { userId, role } = req.user;
        if (role !== 'mentor') return res.status(403).json({ error: 'Only mentors can respond to requests' });

        const { id } = req.params;
        const { decision } = req.body;
        if (!['accepted', 'declined'].includes(decision)) {
            return res.status(400).json({ error: "decision must be 'accepted' or 'declined'" });
        }

        const [[request]] = await pool.execute(
            `SELECT * FROM mentorship_requests WHERE request_id = :id AND mentor_id = :userId`,
            { id, userId }
        );
        if (!request) return res.status(404).json({ error: 'Request not found' });
        if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided' });


        // Accepting checks the limit and saves in one transaction with the mentor's
        // row locked, so two accepts at the same moment cannot go over the limit
        const conn = await pool.getConnection();
        let nowFull = false;
        try {
            await conn.beginTransaction();
            const [[cap]] = await conn.execute(
                'SELECT max_mentees FROM mentors WHERE user_id = :userId FOR UPDATE',
                { userId }
            );
            if (decision === 'accepted') {
                const [[{ active }]] = await conn.execute(
                    "SELECT COUNT(*) AS active FROM mentorship_requests WHERE mentor_id = :userId AND status = 'accepted'",
                    { userId }
                );
                if (cap && Number(active) >= Number(cap.max_mentees)) {
                    await conn.rollback();
                    return res.status(409).json({
                        code: 'at_capacity',
                        error: `You already mentor ${active}, the most you chose. Raise the limit on your profile, or end a mentorship first.`
                    });
                }
                nowFull = cap && Number(active) + 1 >= Number(cap.max_mentees);
            }
            const [changed] = await conn.execute(
                `UPDATE mentorship_requests SET status = :decision, responded_at = NOW() WHERE request_id = :id AND status = 'pending'`,
                { decision, id }
            );
            if (!changed.affectedRows) {
                await conn.rollback();
                return res.status(400).json({ error: 'This request has already been decided' });
            }
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        // Tell the mentee the outcome
        const mentorName = await getUserName(userId);
        await createNotification(
            request.mentee_id,
            `request_${decision}`,
            decision === 'accepted'
                ? `${mentorName} accepted your mentorship request. Their email is now on your requests page.`
                : `${mentorName} declined your mentorship request.`,
            'requests.html'
        );

        // Now full: the other people waiting are told, so they can ask someone else
        if (nowFull) await tellWaitingMentees(userId, 'full');

        res.json({ request_id: Number(id), status: decision });
    } catch (err) { next(err); }
}

async function endMentorship(req, res, next) {
  try {
    const { userId, role } = req.user;
    const { id } = req.params;
    const column = role === 'mentor' ? 'mentor_id' : 'mentee_id';

    const [[request]] = await pool.execute(
      `SELECT * FROM mentorship_requests WHERE request_id = :id AND ${column} = :userId`,
      { id, userId }
    );
    if (!request) return res.status(404).json({ error: 'Mentorship not found' });
    if (request.status !== 'accepted') return res.status(400).json({ error: 'Only an active mentorship can be ended' });

    await pool.execute(
      `UPDATE mentorship_requests SET status = 'ended', ended_by = :userId, ended_at = NOW() WHERE request_id = :id`,
      { userId, id }
    );

    // Tell the other person in the mentorship
    const otherUserId = role === 'mentor' ? request.mentee_id : request.mentor_id;
    const enderName = await getUserName(userId);
    await createNotification(
      otherUserId,
      'mentorship_ended',
      `${enderName} ended your mentorship.`,
      'requests.html'
    );

    res.json({ request_id: Number(id), status: 'ended' });
  } catch (err) { next(err); }
}

async function withdrawRequest(req, res, next) {
  try {
    const { userId, role } = req.user;
    if (role !== 'mentee') return res.status(403).json({ error: 'Only mentees can withdraw a request' });

    const { id } = req.params;
    const [[request]] = await pool.execute(
      `SELECT * FROM mentorship_requests WHERE request_id = :id AND mentee_id = :userId`,
      { id, userId }
    );
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Only a pending request can be withdrawn' });

    await pool.execute(`DELETE FROM mentorship_requests WHERE request_id = :id`, { id });

    // Tell the mentor so the request doesn't just silently vanish from their list
    const menteeName = await getUserName(userId);
    await createNotification(
      request.mentor_id,
      'request_withdrawn',
      `${menteeName} withdrew their mentorship request.`,
      'requests.html'
    );

    res.json({ success: true });
  } catch (err) { next(err); }
}

module.exports = { expireStaleRequests, tellWaitingMentees, createRequest, listMyRequests, respondToRequest, withdrawRequest, endMentorship };