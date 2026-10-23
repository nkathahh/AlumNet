/*
 * How well an opportunity, event or mentor fits a member, in words people
 * can act on ("Strong fit", "You have 3 of 5 skills it asks for") instead of
 * raw similarity numbers. A cosine similarity is not a percentage of fit, so
 * the score is only used for ranking and to pick a band.
 */

// Bands for BGE similarity scores (0 to 100). Set from the evaluation data;
// change them here and every screen follows.
const FIT_BANDS = [
  { min: 72, band: 'strong', label: 'Strong fit' },
  { min: 62, band: 'good', label: 'Good fit' },
  { min: -Infinity, band: 'some', label: 'Some overlap' }
];

function bandFor(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return null;
  const b = FIT_BANDS.find((x) => Number(score) >= x.min);
  return { band: b.band, label: b.label };
}

const STOP = new Set(['and', 'the', 'of', 'in', 'for', 'with', 'to', 'a', 'an', 'skills', 'skill', 'experience', 'knowledge', 'management']);

function tokens(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9+#\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
}

// "Microsoft Excel" matches "Excel"; "team leadership" matches "leadership"
function skillMatches(required, owned) {
  const a = required.toLowerCase().trim();
  const b = owned.toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = tokens(a);
  const tb = new Set(tokens(b));
  if (!ta.length || !tb.size) return false;
  const shared = ta.filter((t) => tb.has(t) || [...tb].some((o) => o.length > 4 && t.length > 4 && (o.startsWith(t.slice(0, 5)) || t.startsWith(o.slice(0, 5))))).length;
  return shared / ta.length >= 0.5;
}

function splitList(text, max, maxLen) {
  const seen = new Set();
  return String(text || '').split(/[,;\n]/).map((x) => x.trim()).filter((x) => {
    const key = x.toLowerCase();
    if (!x || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max).map((x) => x.slice(0, maxLen));
}

// Which of the skills a post asks for the member already has
function skillCoverage(requiredText, memberSkillsText) {
  const required = splitList(requiredText, 8, 40);
  const owned = splitList(memberSkillsText, 40, 60);
  const have = required.filter((r) => owned.some((o) => skillMatches(r, o)));
  const missing = required.filter((r) => !have.includes(r));
  return { required, have, missing, ratio: required.length ? have.length / required.length : null };
}

// Words too general to show a real shared interest ("flight operations" and
// "cargo operations" are different things)
const GENERIC = new Set(['operations', 'operation', 'services', 'service', 'planning', 'development', 'team', 'teams', 'staff', 'work', 'career', 'careers', 'general', 'support', 'roles', 'role']);

// Topics of an event that overlap with what the member says they want
function topicOverlap(topicsText, memberText) {
  const topics = splitList(topicsText, 6, 30);
  const words = new Set(tokens(memberText));
  const same = (w, m) => w === m || (m.length > 4 && w.length > 4 && m.slice(0, 5) === w.slice(0, 5));
  return topics.filter((t) => tokens(t).filter((w) => !GENERIC.has(w)).some((w) => [...words].some((m) => same(w, m))));
}

// The better of two bands: a clear skills or topic match counts even when
// the wording of the post and the profile differ
function betterBand(a, b) {
  const order = { strong: 3, good: 2, some: 1 };
  if (!a) return b;
  if (!b) return a;
  return order[b.band] > order[a.band] ? b : a;
}

module.exports = { FIT_BANDS, bandFor, betterBand, skillMatches, skillCoverage, splitList, topicOverlap, tokens };
