const pool = require('../config/db');
const { mlPost } = require('../utils/ml');
const { avatarUrl } = require('../utils/images');

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
  u.user_id AS mentor_id, u.name, u.department, u.city, u.country, u.created_at, u.avatar_key,
  p.headline, p.skills, p.experience, p.bio,
  IF(p.gender_in_search = 1, p.gender, NULL) AS gender,
  mt.years_of_experience, mt.accepting_mentees, mt.max_mentees, mt.meeting_mode, mt.availability_note,
  (sd.staff_number IS NOT NULL) AS verified,
  (SELECT COUNT(*) FROM mentorship_requests r WHERE r.mentor_id = u.user_id AND r.status = 'accepted') AS active_mentees,
  EXISTS(SELECT 1 FROM bookmarks bm WHERE bm.mentee_id = :viewerId AND bm.mentor_id = u.user_id) AS saved`;

function shapeCard(r) {
  const active = Number(r.active_mentees || 0);
  const max = Number(r.max_mentees || 0);
  return {
    mentor_id: r.mentor_id,
    name: r.name,
    avatar_url: avatarUrl(r.avatar_key, 96),
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
    skills: String(r.skills || '').split(',').map((x) => x.trim()).filter(Boolean),
    skills_preview: String(r.skills || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 4),
    saved: Boolean(Number(r.saved))
  };
}

// Which of a mentor's skills share a word with the search, so each result can
// say why it came up ("Related to your search: cargo handling")
const STOP = new Set(['with', 'from', 'into', 'help', 'want', 'need', 'about', 'like', 'that', 'this', 'mentor', 'mentors', 'someone', 'would', 'have', 'and', 'the', 'for']);
function relatedSkills(q, skills) {
  const stems = String(q).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.slice(0, 5));
  if (!stems.length) return [];
  return skills.filter((sk) => sk.toLowerCase().split(/[^a-z0-9]+/).some((w) => stems.some((st) => w.startsWith(st)))).slice(0, 3);
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

    // Each filter is kept separately, so each menu's counts can apply every
    // filter except its own (choosing "Finance (4)" then shows 4 mentors)
    const clauses = {};
    const params = { viewerId };
    if (department) { clauses.department = 'u.department = :department'; params.department = department; }
    if (location) { clauses.location = 'u.city = :location'; params.location = location; }
    // Only mentors who agreed to use their gender in search can match this filter
    if (gender) {
      if (!['female', 'male'].includes(gender)) return res.status(400).json({ error: 'Choose women or men mentors' });
      clauses.gender = 'p.gender_in_search = 1 AND p.gender = :gender'; params.gender = gender;
    }
    if (mode) {
      if (!['in_person', 'virtual'].includes(mode)) return res.status(400).json({ error: 'Choose in person or online' });
      clauses.mode = "mt.meeting_mode IN (:mode, 'either')"; params.mode = mode;
    }
    if (minYears > 0) { clauses.minYears = 'COALESCE(mt.years_of_experience, 0) >= :minYears'; params.minYears = minYears; }
    if (availableOnly) {
      clauses.available = `mt.accepting_mentees = 1 AND mt.max_mentees >
        (SELECT COUNT(*) FROM mentorship_requests r2 WHERE r2.mentor_id = u.user_id AND r2.status = 'accepted')`;
    }
    const sqlFor = (except) => {
      const parts = Object.entries(clauses).filter(([k]) => k !== except).map(([, v]) => v);
      return parts.length ? ` AND ${parts.join(' AND ')}` : '';
    };
    const filterSql = sqlFor(null);

    const [rows] = await pool.execute(`SELECT ${CARD_COLUMNS} ${BASE_FROM} ${filterSql}`, params);
    let cards = rows.map(shapeCard);

    // Search by meaning first; if the matching service is down, fall back to words
    let searchMode = null;
    if (q) {
      const scores = new Map();
      try {
        // The candidate list goes in the request body, so it works for any number of mentors
        const { data } = await mlPost('/search', { q, ids: cards.map((c) => c.mentor_id) }, 15000);
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
    if (q) cards = cards.map((c) => ({ ...c, related_skills: relatedSkills(q, c.skills) }));

    // Counts for the filter menus, each using every other active filter
    const facet = async (column, key) => {
      const [rowsF] = await pool.execute(
        `SELECT ${column} AS value, COUNT(*) AS n ${BASE_FROM} ${sqlFor(key)} AND ${column} IS NOT NULL AND ${column} != ''
         GROUP BY ${column} ORDER BY ${column}`,
        params
      );
      return rowsF.map((r) => ({ value: r.value, count: Number(r.n) }));
    };
    const departments = await facet('u.department', 'department');
    // Cities only: mixing "Kenya" and "Nairobi" in one menu was confusing
    const locations = await facet('u.city', 'location');
    const genders = (await facet("IF(p.gender_in_search = 1, p.gender, NULL)", 'gender')).filter((g) => ['female', 'male'].includes(g.value));

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
      facets: { departments, locations, genders }
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

/*
 * A mentee's shortlist. Only 5 requests can wait at once, so mentees save
 * mentors they are considering and compare them before asking.
 */
const MAX_SAVED = 30;
async function listSaved(req, res, next) {
  try {
    const [rows] = await pool.execute('SELECT mentor_id FROM bookmarks WHERE mentee_id = :me ORDER BY bookmarked_at DESC', { me: req.user.userId });
    res.json(await cardsFor(req.user.userId, rows.map((r) => r.mentor_id)));
  } catch (err) { next(err); }
}

async function saveMentor(req, res, next) {
  try {
    const mentorId = Number(req.params.id);
    const [[mentor]] = await pool.execute(`SELECT u.user_id ${BASE_FROM} AND u.user_id = :mentorId`, { viewerId: req.user.userId, mentorId });
    if (!mentor) return res.status(404).json({ error: 'Mentor not found' });
    const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM bookmarks WHERE mentee_id = :me', { me: req.user.userId });
    if (Number(n) >= MAX_SAVED) return res.status(409).json({ error: `You can save up to ${MAX_SAVED} mentors. Remove some first.` });
    await pool.execute('INSERT IGNORE INTO bookmarks (mentee_id, mentor_id) VALUES (:me, :mentorId)', { me: req.user.userId, mentorId });
    res.status(201).json({ saved: true });
  } catch (err) { next(err); }
}

async function unsaveMentor(req, res, next) {
  try {
    await pool.execute('DELETE FROM bookmarks WHERE mentee_id = :me AND mentor_id = :mentorId', { me: req.user.userId, mentorId: Number(req.params.id) });
    res.json({ saved: false });
  } catch (err) { next(err); }
}

module.exports = { listMentors, cardsFor, shapeCard, listSaved, saveMentor, unsaveMentor };
