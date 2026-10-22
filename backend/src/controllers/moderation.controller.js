const pool = require('../config/db');
const { createNotification } = require('../utils/notify');
const { parseFlags } = require('./safety.controller');
const {
  REJECTION_REASONS, SCAM_REASON, getSetting, posterTrust, learnFromApproval, learnFromScam
} = require('../utils/moderation');

// The two kinds of post that go through moderation, described once
const KINDS = {
  opportunity: {
    table: 'career_opportunities', id: 'opportunity_id', status: 'approval_status', owner: 'posted_by',
    link: 'apply_link', label: 'opportunity', page: 'opportunities.html'
  },
  event: {
    table: 'events', id: 'event_id', status: 'status', owner: 'created_by',
    link: 'location', label: 'event', page: 'events.html'
  }
};

function lazyLog() {
  return require('./admin.controller').logAdminAction;
}

function parseList(text) {
  try { return JSON.parse(text || '[]'); } catch { return []; }
}

async function loadPost(kind, id) {
  const k = KINDS[kind];
  if (!k) return null;
  const [[row]] = await pool.execute(
    `SELECT p.*, p.${k.id} AS id, p.${k.status} AS state, p.${k.owner} AS owner_id, u.name AS owner_name
     FROM ${k.table} p LEFT JOIN users u ON u.user_id = p.${k.owner} WHERE p.${k.id} = :id`,
    { id }
  );
  return row || null;
}

/*
 * One place for every moderation decision, used by the admin screens, the
 * old review endpoints, "approve all clean" and the fast lane.
 * adminId is null for automatic decisions.
 */
async function applyDecision({ kind, id, decision, reason, note, adminId, automatic = false }) {
  const k = KINDS[kind];
  const post = await loadPost(kind, id);
  if (!post) return { status: 404, error: 'Not found' };
  if (!['pending', 'changes_requested'].includes(post.state) && decision !== 'take_down') {
    return { status: 409, error: 'This has already been reviewed' };
  }
  if (decision === 'take_down' && !(post.state === 'approved')) return { status: 409, error: 'Only a live post can be taken down' };
  if ((decision === 'rejected' || decision === 'take_down') && !REJECTION_REASONS[reason]) {
    return { status: 400, error: 'Choose a reason, so the poster knows what to fix' };
  }
  if (decision === 'changes_requested' && !note) return { status: 400, error: 'Say what needs to change' };

  const newState = decision === 'take_down' ? 'rejected' : decision;
  await pool.execute(
    `UPDATE ${k.table} SET ${k.status} = :state, rejection_reason = :reason, review_note = :note,
       reviewed_at = NOW(), auto_approved = IF(:auto, 1, auto_approved) WHERE ${k.id} = :id`,
    { state: newState, reason: newState === 'rejected' ? reason : null, note: note || null, auto: automatic ? 1 : 0, id }
  );
  if (kind === 'opportunity' && adminId && decision !== 'changes_requested') {
    await pool.execute(
      `INSERT INTO content_approvals (admin_id, opportunity_id, status, review_notes) VALUES (:adminId, :id, :status, :note)`,
      { adminId, id, status: newState === 'approved' ? 'approved' : 'rejected', note: note || null }
    );
  }

  // Learning from people's decisions; automatic approvals teach nothing
  const link = post[k.link];
  if (newState === 'approved' && adminId) await learnFromApproval(link, adminId);
  if (newState === 'rejected' && reason === SCAM_REASON) await learnFromScam(link, adminId, post.title);

  const title = post.title;
  const who = post.owner_name ? ` by ${post.owner_name}` : '';
  const why = reason ? REJECTION_REASONS[reason] : '';
  const words = {
    approved: automatic ? `Auto-approved ${k.label} "${title}"${who}` : `Approved ${k.label} "${title}"${who}`,
    rejected: `Rejected ${k.label} "${title}"${who}. Reason: ${why}`,
    changes_requested: `Asked for changes to ${k.label} "${title}"${who}`,
    take_down: `Took down auto-approved ${k.label} "${title}"${who}. Reason: ${why}`
  }[decision];
  const action = {
    approved: automatic ? `auto_approved_${kind}` : `approved_${kind}`,
    rejected: `rejected_${kind}`,
    changes_requested: `changes_${kind}`,
    take_down: `take_down_${kind}`
  }[decision];
  const extra = automatic && post.lane_reasons ? `. ${parseList(post.lane_reasons).join('; ')}` : (note ? `. Note: ${note}` : '');
  await lazyLog()(adminId, action, k.table, id, `${words}${extra}`, title);

  if (post.owner_id) {
    const message = {
      approved: `Your ${k.label} "${title}" is now live.`,
      rejected: `Your ${k.label} "${title}" was not approved: ${why}.${note ? ' ' + note : ''}`,
      changes_requested: `Please update your ${k.label} "${title}": ${note}`,
      take_down: `Your ${k.label} "${title}" was taken down: ${why}.`
    }[decision];
    await createNotification(post.owner_id, `${kind}_${newState}`, message, k.page);
  }
  return { status: 200, state: newState };
}

/* ------------------------------------------------------------------
   Admin screens
   ------------------------------------------------------------------ */

async function waitingItems() {
  const [opps] = await pool.query(`
    SELECT 'opportunity' AS kind, co.opportunity_id AS id, co.title, co.company, co.description, co.location,
           co.apply_link AS link, co.opportunity_type, co.industry, co.closing_date, NULL AS event_date, NULL AS mode,
           co.approval_status AS state, co.risk_level, co.risk_flags, co.moderation_lane, co.lane_reasons,
           co.review_note, co.submitted_at, co.posted_by AS owner_id, u.name AS owner_name,
           (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'opportunity' AND r.target_id = co.opportunity_id AND r.status = 'open') AS open_reports
    FROM career_opportunities co JOIN users u ON u.user_id = co.posted_by
    WHERE co.approval_status = 'pending'`);
  const [events] = await pool.query(`
    SELECT 'event' AS kind, e.event_id AS id, e.title, NULL AS company, e.description, e.location,
           IF(e.mode = 'virtual', e.location, NULL) AS link, NULL AS opportunity_type, NULL AS industry, NULL AS closing_date,
           e.event_date, e.mode, e.status AS state, e.risk_level, e.risk_flags, e.moderation_lane, e.lane_reasons,
           e.review_note, e.submitted_at, e.created_by AS owner_id, u.name AS owner_name,
           (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'event' AND r.target_id = e.event_id AND r.status = 'open') AS open_reports
    FROM events e JOIN users u ON u.user_id = e.created_by
    WHERE e.status = 'pending'`);
  const laneOrder = { hold: 0, queue: 1, fast: 2 };
  const riskOrder = { high: 0, medium: 1, low: 2 };
  return [...opps, ...events]
    .map((r) => ({
      ...r,
      risk_flags: parseFlags(r.risk_flags),
      lane_reasons: parseList(r.lane_reasons),
      moderation_lane: r.moderation_lane || 'queue',
      open_reports: Number(r.open_reports),
      waiting_hours: r.submitted_at ? Math.round((Date.now() - new Date(r.submitted_at)) / 36e5) : null,
      clean: (r.risk_level || 'low') === 'low' && !parseFlags(r.risk_flags).length && Number(r.open_reports) === 0 && (r.moderation_lane || 'queue') !== 'hold'
    }))
    .sort((a, b) => laneOrder[a.moderation_lane] - laneOrder[b.moderation_lane]
      || riskOrder[a.risk_level || 'low'] - riskOrder[b.risk_level || 'low']
      || new Date(a.submitted_at) - new Date(b.submitted_at));
}

async function getQueue(req, res, next) {
  try {
    const items = await waitingItems();
    // Trust details for each poster, so the admin sees why someone is or is not trusted
    const trustCache = new Map();
    for (const item of items) {
      if (!trustCache.has(item.owner_id)) trustCache.set(item.owner_id, await posterTrust(item.owner_id));
      item.poster_trust = trustCache.get(item.owner_id);
    }
    const [autoOpps] = await pool.query(`
      SELECT 'opportunity' AS kind, co.opportunity_id AS id, co.title, co.company, co.apply_link AS link, co.approval_status AS state,
             co.reviewed_at, co.lane_reasons, u.name AS owner_name
      FROM career_opportunities co JOIN users u ON u.user_id = co.posted_by
      WHERE co.auto_approved = 1 AND co.reviewed_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    const [autoEvents] = await pool.query(`
      SELECT 'event' AS kind, e.event_id AS id, e.title, NULL AS company, e.location AS link, e.status AS state,
             e.reviewed_at, e.lane_reasons, u.name AS owner_name
      FROM events e JOIN users u ON u.user_id = e.created_by
      WHERE e.auto_approved = 1 AND e.reviewed_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    const autoApproved = [...autoOpps, ...autoEvents]
      .map((r) => ({ ...r, lane_reasons: parseList(r.lane_reasons) }))
      .sort((a, b) => new Date(b.reviewed_at) - new Date(a.reviewed_at));
    res.json({
      items,
      autoApproved,
      autoApprove: (await getSetting('auto_approve', 'off')) === 'on',
      reasons: REJECTION_REASONS,
      stale: items.filter((i) => i.waiting_hours >= 48).length
    });
  } catch (err) { next(err); }
}

async function decide(req, res, next) {
  try {
    const { kind, id } = req.params;
    const { decision, reason } = req.body;
    if (!KINDS[kind]) return res.status(404).json({ error: 'Not found' });
    if (!['approved', 'rejected', 'changes_requested', 'take_down'].includes(decision)) {
      return res.status(400).json({ error: 'Choose approve, request changes, reject or take down' });
    }
    const note = String(req.body.note || '').trim().slice(0, 255);
    const result = await applyDecision({ kind, id, decision, reason, note, adminId: req.user.userId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ state: result.state });
  } catch (err) { next(err); }
}

// One click for posts with no warnings, no reports and nothing held; each is still logged
async function approveClean(req, res, next) {
  try {
    const clean = (await waitingItems()).filter((i) => i.clean && i.moderation_lane === 'queue');
    for (const item of clean) {
      await applyDecision({ kind: item.kind, id: item.id, decision: 'approved', adminId: req.user.userId });
    }
    res.json({ approved: clean.length });
  } catch (err) { next(err); }
}

async function setAutoApprove(req, res, next) {
  try {
    const on = req.body.autoApprove === true;
    await pool.execute(
      `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES ('auto_approve', :value, :adminId)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      { value: on ? 'on' : 'off', adminId: req.user.userId }
    );
    await lazyLog()(req.user.userId, 'settings', 'app_settings', 0, `Turned the fast lane ${on ? 'on' : 'off'}`, 'Fast lane');
    res.json({ autoApprove: on });
  } catch (err) { next(err); }
}

/*
 * How well the automatic checks agree with what admins actually decided.
 * Only human decisions count, so the system is not grading itself.
 */
async function insights(req, res, next) {
  try {
    const [rows] = await pool.query(`
      SELECT COALESCE(risk_level, 'low') AS risk, ${'approval_status'} AS state, rejection_reason, auto_approved,
             TIMESTAMPDIFF(MINUTE, COALESCE(submitted_at, created_at), reviewed_at) AS minutes
      FROM career_opportunities WHERE reviewed_at IS NOT NULL
      UNION ALL
      SELECT COALESCE(risk_level, 'low'), status, rejection_reason, auto_approved,
             TIMESTAMPDIFF(MINUTE, COALESCE(submitted_at, created_at), reviewed_at)
      FROM events WHERE reviewed_at IS NOT NULL AND created_by IS NOT NULL`);
    const byRisk = {};
    for (const level of ['low', 'medium', 'high']) {
      const human = rows.filter((r) => r.risk === level && !r.auto_approved && ['approved', 'rejected'].includes(r.state));
      const rejected = human.filter((r) => r.state === 'rejected').length;
      byRisk[level] = { decided: human.length, approved: human.length - rejected, rejected, rejectedShare: human.length ? Math.round((rejected / human.length) * 100) : null };
    }
    const auto = rows.filter((r) => r.auto_approved);
    const takenDown = auto.filter((r) => r.state === 'rejected').length;
    const times = rows.filter((r) => !r.auto_approved && r.minutes !== null).map((r) => r.minutes).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    const [[lists]] = await pool.query(
      'SELECT (SELECT COUNT(*) FROM trusted_domains) AS known_sites, (SELECT COUNT(*) FROM blocked_indicators) AS blocked'
    );
    res.json({
      byRisk,
      autoApproved: auto.length,
      autoTakenDown: takenDown,
      medianHoursToDecision: median === null ? null : Math.round((median / 60) * 10) / 10,
      knownSites: lists.known_sites,
      blocked: lists.blocked
    });
  } catch (err) { next(err); }
}

async function listLearned(req, res, next) {
  try {
    const [known] = await pool.query('SELECT domain, approvals, created_at FROM trusted_domains ORDER BY approvals DESC, domain');
    const [blocked] = await pool.query('SELECT indicator_id, kind, value, reason, created_at FROM blocked_indicators ORDER BY created_at DESC');
    res.json({ known, blocked });
  } catch (err) { next(err); }
}

async function unblockIndicator(req, res, next) {
  try {
    const [[row]] = await pool.execute('SELECT kind, value FROM blocked_indicators WHERE indicator_id = :id', { id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found' });
    await pool.execute('DELETE FROM blocked_indicators WHERE indicator_id = :id', { id: req.params.id });
    await lazyLog()(req.user.userId, 'unblock_indicator', 'blocked_indicators', req.params.id, `Removed ${row.value} from the blocked list`, row.value);
    res.json({ removed: true });
  } catch (err) { next(err); }
}

async function forgetKnownSite(req, res, next) {
  try {
    const domain = String(req.params.domain || '').toLowerCase();
    await pool.execute('DELETE FROM trusted_domains WHERE domain = :domain', { domain });
    await lazyLog()(req.user.userId, 'forget_site', 'trusted_domains', 0, `Removed ${domain} from known employer websites`, domain);
    res.json({ removed: true });
  } catch (err) { next(err); }
}

// Runs with the clean-up job: tells admins when posts have waited too long.
// Waiting never leads to automatic approval.
async function remindStale() {
  try {
    const stale = (await waitingItems()).filter((i) => i.waiting_hours >= 48).length;
    if (!stale) return;
    const [admins] = await pool.query("SELECT a.user_id FROM admins a JOIN users u ON u.user_id = a.user_id WHERE u.status = 'active'");
    const message = `${stale} post${stale === 1 ? ' has' : 's have'} waited more than 48 hours for review.`;
    for (const a of admins) {
      const [[recent]] = await pool.execute(
        "SELECT 1 AS hit FROM notifications WHERE user_id = :id AND type = 'moderation_reminder' AND created_at > DATE_SUB(NOW(), INTERVAL 20 HOUR)",
        { id: a.user_id }
      );
      if (!recent) await createNotification(a.user_id, 'moderation_reminder', message, 'admin.html#opportunities');
    }
  } catch (err) {
    console.error('Moderation reminder skipped:', err.message);
  }
}

module.exports = {
  KINDS, applyDecision, getQueue, decide, approveClean, setAutoApprove, insights, listLearned,
  unblockIndicator, forgetKnownSite, remindStale
};
