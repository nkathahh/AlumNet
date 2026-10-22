const pool = require('../config/db');
const { mlGet } = require('../utils/ml');

const PAGE_SIZE = 12;
// Search keeps results that are clearly related to the query: at least this
// score, and within this many points of the best result. Tune with real profiles.
const SEARCH_MIN_SCORE = 30;
const SEARCH_BAND = 12;
const MODES = { in_person: 'In person', virtual: 'Online', either: 'In person or online' };

/*
 * Mentors a member can see: active, HR lists them as former staff (or an
 * older account not linked to HR), not blocked either way.
 */
const BASE_FROM = `
  FROM mentors mt
  JOIN users u ON u.user_id = mt.user_id
  LEFT JOIN profiles p ON p.user_id = mt.user_id
  LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
  WHERE u.status = 'active'
    AND (sd.staff_number IS NULL OR (sd.employment_status = 'former' AND sd.alumni_eligible = 1))
    AND u.user_id != :viewerId
    AND NOT EXISTS (SELECT 1 FROM user_blocks b
                    WHERE (b.blocker_id = :viewerId AND b.blocked_id = u.user_id)
                       OR (b.blocker_id = u.user_id AND b.blocked_id = :viewerId))`;

const CARD_COLUMNS = `
  u.user_id AS mentor_id, u.name, u.department, u.city, u.country, u.created_at,
  p.headline, p.skills, p.experience, p.bio,
  IF(p.gender_in_search = 1, p.gender, NULL) AS gender,
  mt.years_of_experience, mt.accepting_mentees, mt.max_mentees, mt.meeting_mode, mt.availability_note,
  (sd.staff_number IS NOT NULL) AS verified,
  (SELECT COUNT(*) FROM mentorship_requests r WHERE r.mentor_id = u.user_id AND r.status = 'accepted') AS active_mentees`;

function shapeCard(r) {
  const active = Number(r.active_mentees || 0);
  const max = Number(r.max_mentees || 0);
  return {
    mentor_id: r.mentor_id,
    name: r.name,
    headline: r.headline,
    department: r.department,
    city: r.city,
    country: r.country,
    gender: r.gender || null,
    years_of_experience: r.years_of_experience,
    verified: Boolean(Number(r.verified)),
    accepting_mentees: Boolean(Number(r.accepting_mentees)),
    active_mentees: active,
    max_mentees: max,
    slots_left: Math.max(0, max - active),
    // "Available" means they are taking mentees and have a free place
    available: Boolean(Number(r.accepting_mentees)) && active < max,
    meeting_mode: r.meeting_mode,
    meeting_label: MODES[r.meeting_mode] || null,
    availability_note: r.availability_note,
    skills_preview: String(r.skills || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 4)
  };
}

// Words people type that mean the same filter, so "women mentors" works
function keywordWhere(q) {
  const words = String(q).toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2).slice(0, 6);
  if (!words.length) return { sql: '', params: {} };
  const params = {};
  const parts = words.map((w, i) => {
    params[`kw${i}`] = `%${w}%`;
    return `(LOWER(CONCAT_WS(' ', u.name, u.department, p.headline, p.bio, p.skills, p.experience)) LIKE :kw${i})`;
  });
  // Any word matches; the more words match, the higher it ranks
  return { sql: ` AND (${parts.join(' OR ')})`, params, score: parts.map((x) => `(${x.slice(1, -1)})`).join(' + ') };
}

/*
 * GET /api/mentors
 * q, department, minYears, location, gender, mode, available (1 by default),
 * sort (match | experience | newest | name), page
 */
async function listMentors(req, res, next) {
  try {
    const viewerId = req.user.userId;
    const q = String(req.query.q || '').trim().slice(0, 200);
    const department = String(req.query.department || '').trim();
    const location = String(req.query.location || '').trim();
    const gender = String(req.query.gender || '').trim();
    const mode = String(req.query.mode || '').trim();
    const minYears = Number(req.query.minYears || 0);
    const availableOnly = req.query.available !== '0';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    let sort = String(req.query.sort || (q ? 'match' : 'experience'));

    const where = [];
    const params = { viewerId };
    if (department) { where.push('u.department = :department'); params.department = department; }
    if (location) { where.push('(u.city = :location OR u.country = :location)'); params.location = location; }
    // Only mentors who agreed to use their gender in search can match this filter
    if (gender) {
      if (!['female', 'male'].includes(gender)) return res.status(400).json({ error: 'Choose women or men mentors' });
      where.push('p.gender_in_search = 1 AND p.gender = :gender'); params.gender = gender;
    }
    if (mode) {
      if (!['in_person', 'virtual'].includes(mode)) return res.status(400).json({ error: 'Choose in person or online' });
      where.push("mt.meeting_mode IN (:mode, 'either')"); params.mode = mode;
    }
    if (minYears > 0) { where.push('COALESCE(mt.years_of_experience, 0) >= :minYears'); params.minYears = minYears; }
    if (availableOnly) {
      where.push(`mt.accepting_mentees = 1 AND mt.max_mentees >
        (SELECT COUNT(*) FROM mentorship_requests r2 WHERE r2.mentor_id = u.user_id AND r2.status = 'accepted')`);
    }
    const filterSql = where.length ? ` AND ${where.join(' AND ')}` : '';

    const [rows] = await pool.execute(`SELECT ${CARD_COLUMNS} ${BASE_FROM} ${filterSql}`, params);
    let cards = rows.map(shapeCard);

    // Search by meaning first; if the matching service is down, fall back to words
    let searchMode = null;
    if (q) {
      const scores = new Map();
      try {
        const { data } = await mlGet('/search', { q, ids: cards.map((c) => c.mentor_id).join(',') }, 15000);
        data.forEach((r) => scores.set(r.mentor_id, r.score));
        searchMode = 'meaning';
        const best = Math.max(0, ...data.map((r) => r.score));
        const cutoff = Math.max(SEARCH_MIN_SCORE, best - SEARCH_BAND);
        cards = cards.filter((c) => (scores.get(c.mentor_id) ?? 0) >= cutoff)
          .map((c) => ({ ...c, relevance: scores.get(c.mentor_id) }));
      } catch {
        searchMode = 'keywords';
        const kw = keywordWhere(q);
        if (!kw.sql) {
          cards = [];
        } else {
          const [hits] = await pool.execute(
            `SELECT u.user_id AS id, (${kw.score}) AS hits ${BASE_FROM} ${filterSql} ${kw.sql}`,
            { ...params, ...kw.params }
          );
          const hitMap = new Map(hits.map((h) => [h.id, Number(h.hits)]));
          cards = cards.filter((c) => hitMap.has(c.mentor_id)).map((c) => ({ ...c, relevance: hitMap.get(c.mentor_id) }));
        }
      }
    } else if (sort === 'match') {
      sort = 'experience';
    }

    const sorters = {
      match: (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || b.slots_left - a.slots_left,
      experience: (a, b) => (b.years_of_experience ?? -1) - (a.years_of_experience ?? -1) || a.name.localeCompare(b.name),
      newest: (a, b) => b.mentor_id - a.mentor_id,
      // Mentors with the most free places first, which spreads mentees across mentors
      availability: (a, b) => Number(b.available) - Number(a.available) || b.slots_left - a.slots_left || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name)
    };
    cards.sort(sorters[sort] || sorters.experience);

    // Counts for the filter menus, from all visible mentors (ignoring the other filters)
    const [facetRows] = await pool.execute(
      `SELECT u.department, u.city, u.country, IF(p.gender_in_search = 1, p.gender, NULL) AS gender ${BASE_FROM}`,
      { viewerId }
    );
    const count = (key) => {
      const m = new Map();
      facetRows.forEach((r) => { if (r[key]) m.set(r[key], (m.get(r[key]) || 0) + 1); });
      return [...m.entries()].map(([value, n]) => ({ value, count: n })).sort((a, b) => a.value.localeCompare(b.value));
    };
    const locations = new Map();
    facetRows.forEach((r) => [r.city, r.country].filter(Boolean).forEach((v) => locations.set(v, (locations.get(v) || 0) + 1)));

    const total = cards.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(page, pages);
    res.json({
      items: cards.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
      total,
      page: current,
      pages,
      pageSize: PAGE_SIZE,
      searchMode,
      facets: {
        departments: count('department'),
        locations: [...locations.entries()].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
        genders: count('gender').filter((g) => ['female', 'male'].includes(g.value))
      }
    });
  } catch (err) { next(err); }
}

// Card details for a list of mentor IDs, in the order given (used by recommendations)
async function cardsFor(viewerId, ids) {
  if (!ids.length) return [];
  const marks = ids.map((_, i) => `:id${i}`).join(',');
  const params = { viewerId };
  ids.forEach((id, i) => { params[`id${i}`] = id; });
  const [rows] = await pool.execute(`SELECT ${CARD_COLUMNS} ${BASE_FROM} AND u.user_id IN (${marks})`, params);
  const byId = new Map(rows.map((r) => [r.mentor_id, shapeCard(r)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

module.exports = { listMentors, cardsFor, shapeCard };
