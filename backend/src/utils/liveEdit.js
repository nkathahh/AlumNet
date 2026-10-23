/*
 * Editing something that is already live. Plans change (a venue moves, a
 * closing date is extended), so posters can edit, but an approved post must
 * not become a way to slip a scam past the alumni office ("bait and switch").
 *
 * An edit stays live only when the same checks a new post gets find nothing,
 * and any new link is on a website the alumni office has approved before.
 * Anything else goes back to the review queue.
 */
const pool = require('../config/db');
const { chooseLane, indicatorsFor, normaliseLink } = require('./moderation');

async function knownLink(link) {
  if (!link) return true;
  const { email, domain } = indicatorsFor(link);
  if (email || !domain) return false;
  const [[hit]] = await pool.execute('SELECT 1 AS hit FROM trusted_domains WHERE domain = :domain', { domain });
  return Boolean(hit);
}

async function reviewEdit(kind, { userId, id, title, oldLink, newLink }, scan) {
  const routed = await chooseLane(kind, { userId, title, link: newLink, excludeId: id }, scan);
  const linkChanged = normaliseLink(oldLink) !== normaliseLink(newLink);
  const linkOk = !linkChanged || await knownLink(newLink);
  const stayLive = routed.lane !== 'hold' && scan.flags.length === 0 && linkOk;
  if (!stayLive) {
    routed.reasons = [
      linkChanged && !linkOk ? 'Edited after it was live: the link was changed to a site not approved before' : 'Edited after it was live',
      ...routed.reasons
    ];
    if (routed.lane === 'fast') routed.lane = 'queue';
  }
  return { stayLive, routed, linkChanged };
}

// "the date and time, the venue": what registered people need to hear about
function eventChanges(before, after) {
  const out = [];
  if (new Date(before.event_date).getTime() !== new Date(after.event_date).getTime()) out.push('the date and time');
  if (before.mode !== after.mode) out.push('the format');
  if (String(before.location || '').trim() !== String(after.location || '').trim()) out.push(after.mode === 'virtual' ? 'the meeting link' : 'the venue');
  return out;
}

function listInWords(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

module.exports = { reviewEdit, eventChanges, listInWords, knownLink };
