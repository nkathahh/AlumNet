/*
 * Smart moderation: decides which lane a new post goes into and learns from
 * admin decisions. Nothing here rejects a post; the worst outcome is "hold",
 * where an admin must look before anything is published.
 *
 *   fast  : published straight away (only if the alumni office switched it on)
 *   queue : an admin approves or rejects as usual
 *   hold  : never published automatically, shown first with the reasons
 */
const pool = require('../config/db');

const FREE_MAIL = /^(gmail|yahoo|outlook|hotmail|ymail|aol|icloud|proton|protonmail)\.[a-z.]+$/i;
// Sites anyone can publish on, so approving one post must not trust them all
const SHARED_HOSTS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy|is\.gd|ow\.ly|shorturl\.at|tiny\.cc|wa\.me|t\.me|forms\.gle|docs\.google\.com|drive\.google\.com|linktr\.ee|sites\.google\.com|wixsite\.com|blogspot\.com|wordpress\.com)$/i;

const REJECTION_REASONS = {
  asks_for_payment: 'Scam, or asks applicants to pay',
  misleading: 'Misleading or false information',
  duplicate: 'Already posted',
  missing_details: 'Missing important details',
  not_relevant: 'Not relevant to the KQ alumni network',
  broken_link: 'The application link does not work'
};
// Only this reason teaches the system that a website or email belongs to a scam
const SCAM_REASON = 'asks_for_payment';

const TRUST = { minAccountDays: 30, minApprovedPosts: 2, burstPerDay: 3 };

// careers.jambojet.com and www.jambojet.com both belong to jambojet.com.
// Kenyan and UK second-level endings (co.ke, ac.ke, go.ke, or.ke, co.uk) keep three parts.
function baseDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const twoPartEnding = /^(co|ac|go|or|ne|sc|me|info)\.(ke|uk|ug|tz|za)$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoPartEnding ? -3 : -2).join('.');
}

// What a link points to: a website domain, or an email address and its domain
function indicatorsFor(link) {
  const value = String(link || '').trim().toLowerCase();
  if (!value) return {};
  if (/^[^\s@]+@[^\s@]+$/.test(value)) {
    const domain = value.split('@')[1];
    return { email: value, domain: FREE_MAIL.test(domain) ? null : baseDomain(domain) };
  }
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    return { domain: SHARED_HOSTS.test(host) ? host : baseDomain(host), host };
  } catch {
    return {};
  }
}

function canTrustDomain(domain) {
  return Boolean(domain) && !FREE_MAIL.test(domain) && !SHARED_HOSTS.test(domain) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(domain);
}

async function getSetting(key, fallback) {
  const [[row]] = await pool.execute('SELECT setting_value FROM app_settings WHERE setting_key = :key', { key });
  return row ? row.setting_value : fallback;
}

/*
 * Whether a member's posts can skip the queue, with every check shown as a
 * plain reason so the admin (and the examiner) can see why.
 */
async function posterTrust(userId) {
  const [[u]] = await pool.execute(
    `SELECT u.created_at, u.totp_enabled, sd.employment_status, sd.alumni_eligible
     FROM users u LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
     WHERE u.user_id = :userId`,
    { userId }
  );
  if (!u) return { trusted: false, checks: [] };
  const [[history]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM career_opportunities WHERE posted_by = :userId AND approval_status = 'approved' AND auto_approved = 0)
     + (SELECT COUNT(*) FROM events WHERE created_by = :userId AND status = 'approved' AND auto_approved = 0) AS approved,
       (SELECT COUNT(*) FROM career_opportunities WHERE posted_by = :userId AND rejection_reason IN ('asks_for_payment','misleading'))
     + (SELECT COUNT(*) FROM events WHERE created_by = :userId AND rejection_reason IN ('asks_for_payment','misleading')) AS bad_rejections,
       (SELECT COUNT(*) FROM career_opportunities WHERE posted_by = :userId AND auto_approved = 1 AND approval_status = 'rejected')
     + (SELECT COUNT(*) FROM events WHERE created_by = :userId AND auto_approved = 1 AND status = 'rejected') AS taken_down,
       (SELECT COUNT(*) FROM reports r
          LEFT JOIN career_opportunities co ON r.target_type = 'opportunity' AND co.opportunity_id = r.target_id
          LEFT JOIN events e ON r.target_type = 'event' AND e.event_id = r.target_id
        WHERE r.status = 'actioned'
          AND COALESCE(IF(r.target_type = 'user', r.target_id, NULL), co.posted_by, e.created_by) = :userId) AS upheld`,
    { userId }
  );
  const ageDays = (Date.now() - new Date(u.created_at).getTime()) / 864e5;
  const checks = [
    { ok: u.employment_status === 'former' && Boolean(u.alumni_eligible), label: 'Verified former KQ staff' },
    { ok: ageDays >= TRUST.minAccountDays, label: `Account at least ${TRUST.minAccountDays} days old` },
    { ok: Number(history.approved) >= TRUST.minApprovedPosts, label: `${history.approved} of ${TRUST.minApprovedPosts} earlier posts approved by an admin` },
    { ok: Number(history.bad_rejections) === 0 && Number(history.taken_down) === 0, label: 'No posts rejected as scams or misleading, none taken down' },
    { ok: Number(history.upheld) === 0, label: 'No reports upheld against them' },
    { ok: Boolean(u.totp_enabled), label: 'Two-factor authentication on' }
  ];
  return { trusted: checks.every((c) => c.ok), checks };
}

/*
 * kind: 'opportunity' | 'event'
 * post: { userId, title, link, isResubmission, excludeId }
 * scan: result of scanPost
 */
async function chooseLane(kind, post, scan) {
  const hold = [];
  const queue = [];
  const { email, domain } = indicatorsFor(post.link);

  if (scan.level === 'high') hold.push('Automatic scam check: high risk');

  const [blocked] = await pool.execute(
    `SELECT kind, value FROM blocked_indicators
     WHERE (kind = 'domain' AND value = :domain) OR (kind = 'email' AND value = :email) OR (kind = 'link' AND value = :link)`,
    { domain: domain || '', email: email || '', link: normaliseLink(post.link) }
  );
  for (const b of blocked) hold.push(`Uses ${{ email: 'an email', link: 'a link', domain: 'a website' }[b.kind]} from a post rejected as a scam (${b.value})`);

  // A hacked account usually posts a lot, quickly
  const [[{ recent }]] = await pool.execute(
    `SELECT (SELECT COUNT(*) FROM career_opportunities WHERE posted_by = :userId AND submitted_at > DATE_SUB(NOW(), INTERVAL 1 DAY))
          + (SELECT COUNT(*) FROM events WHERE created_by = :userId AND submitted_at > DATE_SUB(NOW(), INTERVAL 1 DAY)) AS recent`,
    { userId: post.userId }
  );
  if (Number(recent) >= TRUST.burstPerDay) {
    hold.push(`This is post number ${Number(recent) + 1} in the last 24 hours from this account (more than ${TRUST.burstPerDay} a day is held)`);
  }

  // The same unknown link from two accounts suggests one scammer using several
  // accounts. A known employer's careers page shared by several alumni is normal.
  const [[knownSite]] = domain
    ? await pool.execute('SELECT 1 AS hit FROM trusted_domains WHERE domain = :domain', { domain })
    : [[null]];
  if (post.link && kind === 'opportunity' && !knownSite) {
    const [[other]] = await pool.execute(
      `SELECT u.name FROM career_opportunities co JOIN users u ON u.user_id = co.posted_by
       WHERE LOWER(TRIM(co.apply_link)) = :link AND co.posted_by != :userId
         AND co.created_at > DATE_SUB(NOW(), INTERVAL 90 DAY) LIMIT 1`,
      { link: String(post.link).trim().toLowerCase(), userId: post.userId }
    );
    if (other) hold.push(`The same application link was posted by another account (${other.name})`);
  }

  // A repeat of the poster's own recent post
  const table = kind === 'opportunity'
    ? { sql: "SELECT title FROM career_opportunities WHERE posted_by = :userId AND LOWER(TRIM(title)) = :title AND approval_status IN ('pending','approved') AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) AND opportunity_id != :excludeId LIMIT 1" }
    : { sql: "SELECT title FROM events WHERE created_by = :userId AND LOWER(TRIM(title)) = :title AND status IN ('pending','approved') AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) AND event_id != :excludeId LIMIT 1" };
  const [[repeat]] = await pool.execute(table.sql, { userId: post.userId, title: String(post.title || '').trim().toLowerCase(), excludeId: post.excludeId || 0 });
  if (repeat) queue.push(`Looks like a repeat of "${repeat.title}" posted in the last 30 days`);

  if (hold.length) return { lane: 'hold', reasons: hold, trust: null };

  if (scan.flags.length) queue.push(`Automatic scam check: ${scan.flags.length} warning${scan.flags.length === 1 ? '' : 's'}`);
  if (post.isResubmission) queue.push('Resubmitted after changes were requested');

  if (domain && kind === 'opportunity') {
    const [[known]] = await pool.execute('SELECT approvals FROM trusted_domains WHERE domain = :domain', { domain });
    if (!known) queue.push(`New website not approved before (${domain})`);
  } else if (kind === 'opportunity' && email) {
    queue.push('Applications go to a personal email, not a company website');
  } else if (kind === 'event' && post.link && domain) {
    const [[known]] = await pool.execute('SELECT approvals FROM trusted_domains WHERE domain = :domain', { domain });
    if (!known) queue.push(`Meeting link on a site not approved before (${domain})`);
  }

  const trust = await posterTrust(post.userId);
  if (!trust.trusted) {
    const missing = trust.checks.filter((c) => !c.ok).map((c) => c.label);
    queue.push(`Poster not yet trusted. Still missing: ${missing.map((m) => m.charAt(0).toLowerCase() + m.slice(1)).join('; ')}`);
  }
  const autoOn = (await getSetting('auto_approve', 'off')) === 'on';
  if (!queue.length && !autoOn) queue.push('Fast lane is switched off');

  if (queue.length) return { lane: 'queue', reasons: queue, trust };
  return {
    lane: 'fast',
    reasons: ['Trusted poster', domain ? `Known employer website (${domain})` : 'No outside link', 'No warnings from the automatic check'],
    trust
  };
}

// Admin approved: the employer's website becomes known
async function learnFromApproval(link, adminId) {
  const { domain } = indicatorsFor(link);
  if (!canTrustDomain(domain)) return;
  await pool.execute(
    `INSERT INTO trusted_domains (domain, approvals, first_approved_by) VALUES (:domain, 1, :adminId)
     ON DUPLICATE KEY UPDATE approvals = approvals + 1`,
    { domain, adminId }
  );
}

function normaliseLink(link) {
  return String(link || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').slice(0, 190);
}

// Admin rejected as a scam: the website or email is blocked for future posts.
// Shortened or shared sites (bit.ly, Google Forms) cannot be blocked whole,
// so the exact link is blocked instead.
async function learnFromScam(link, adminId, title) {
  const { email, domain } = indicatorsFor(link);
  const reason = `Rejected as a scam: "${String(title || '').slice(0, 150)}"`;
  if (!email && link && !canTrustDomain(domain)) {
    await pool.execute('INSERT IGNORE INTO blocked_indicators (kind, value, reason, created_by) VALUES (\'link\', :value, :reason, :adminId)', { value: normaliseLink(link), reason, adminId });
  }
  if (email) {
    await pool.execute('INSERT IGNORE INTO blocked_indicators (kind, value, reason, created_by) VALUES (\'email\', :email, :reason, :adminId)', { email, reason, adminId });
  }
  if (canTrustDomain(domain) && domain !== 'kenya-airways.com') {
    await pool.execute('INSERT IGNORE INTO blocked_indicators (kind, value, reason, created_by) VALUES (\'domain\', :domain, :reason, :adminId)', { domain, reason, adminId });
    await pool.execute('DELETE FROM trusted_domains WHERE domain = :domain', { domain });
  }
}

module.exports = { baseDomain, REJECTION_REASONS, SCAM_REASON, TRUST, indicatorsFor, canTrustDomain, getSetting, posterTrust, chooseLane, learnFromApproval, learnFromScam };

/*
 * After a post is saved: store its lane, publish it straight away if it is
 * in the fast lane, and build the reply for the poster. High-risk posters get
 * a general notice only, so scammers cannot learn which words to change.
 */
async function finishSubmission(kind, id, routed, scan) {
  const table = kind === 'opportunity' ? 'career_opportunities' : 'events';
  const idCol = kind === 'opportunity' ? 'opportunity_id' : 'event_id';
  await pool.execute(
    `UPDATE ${table} SET moderation_lane = :lane, lane_reasons = :reasons WHERE ${idCol} = :id`,
    { lane: routed.lane, reasons: JSON.stringify(routed.reasons), id }
  );
  if (routed.lane === 'fast') {
    const { applyDecision } = require('../controllers/moderation.controller');
    await applyDecision({ kind, id, decision: 'approved', adminId: null, automatic: true });
    return { published: true, message: 'Published. Your post is live now.', needsCloserReview: false, warnings: [] };
  }
  const high = scan.level === 'high' || routed.lane === 'hold';
  return {
    published: false,
    message: 'Submitted for review',
    needsCloserReview: high,
    warnings: high ? [] : scan.flags.map((f) => f.label)
  };
}

module.exports.finishSubmission = finishSubmission;
