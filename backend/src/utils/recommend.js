/*
 * Ranks opportunities and events for one member and explains each choice.
 * The matching service gives a similarity; skills and audience give the
 * reason a person can check. If the service is down, the skills and topic
 * checks still work, so nothing breaks.
 */
const pool = require('../config/db');
const { mlPost } = require('./ml');
const { bandFor, betterBand, skillCoverage, splitList, topicOverlap } = require('./fit');

function opportunityText(o) {
  return [o.title, o.company, o.industry, o.required_skills, o.description].filter(Boolean).join('. ');
}
function eventText(e) {
  return [e.title, e.topics, e.description].filter(Boolean).join('. ');
}

async function memberProfile(userId) {
  const [[p]] = await pool.execute(
    `SELECT u.department, p.skills, p.experience, p.career_interests, p.headline
     FROM users u LEFT JOIN profiles p ON p.user_id = u.user_id WHERE u.user_id = :userId`,
    { userId }
  );
  return p || {};
}

async function similarities(userId, items) {
  if (!items.length) return null;
  try {
    const { data } = await mlPost('/score-items', { user_id: userId, items }, 15000);
    return new Map(data.map((r) => [r.key, r.score]));
  } catch {
    return null;
  }
}

async function annotateOpportunities(userId, rows) {
  const me = await memberProfile(userId);
  const scores = await similarities(userId, rows.map((o) => ({ key: `opp:${o.opportunity_id}`, text: opportunityText(o) })));
  return rows.map((o) => {
    const coverage = skillCoverage(o.required_skills, me.skills);
    const similarity = scores ? scores.get(`opp:${o.opportunity_id}`) ?? null : null;
    // The band is the better of what the model says and what the skills checklist shows;
    // without the matching service, the checklist alone decides
    const fromSkills = coverage.ratio === null ? null : coverage.ratio >= 0.75 ? bandFor(100) : coverage.ratio >= 0.5 ? bandFor(65) : bandFor(0);
    const fit = betterBand(bandFor(similarity), fromSkills);
    const reasons = [];
    if (coverage.required.length) reasons.push(`You have ${coverage.have.length} of ${coverage.required.length} skills it asks for`);
    if (o.industry && me.career_interests && String(me.career_interests).toLowerCase().includes(String(o.industry).toLowerCase().split(' ')[0])) {
      reasons.push(`In ${o.industry}, which you said interests you`);
    }
    const rank = (similarity ?? 50) + 15 * (coverage.ratio ?? 0.3);
    // What the checklist was compared with, so members can see why and fix their profile
    return { ...o, fit, skills_have: coverage.have, skills_missing: coverage.missing, my_skills: splitList(me.skills, 40, 60), fit_reasons: reasons, rank };
  });
}

async function annotateEvents(userId, rows) {
  const me = await memberProfile(userId);
  const memberText = [me.career_interests, me.skills, me.headline].filter(Boolean).join(' ');
  const scores = await similarities(userId, rows.map((e) => ({ key: `event:${e.event_id}`, text: eventText(e) })));
  return rows.map((e) => {
    const audience = splitList(e.audience_departments, 20, 100);
    // Your own event is not "a good fit for you"
    if (e.is_mine) return { ...e, topics_list: splitList(e.topics, 6, 30), audience, for_me: true, fit: null, fit_reasons: [], rank: -1000 };
    const forMe = !audience.length || (me.department && audience.includes(me.department));
    const shared = topicOverlap(e.topics, memberText);
    const similarity = scores ? scores.get(`event:${e.event_id}`) ?? null : null;
    const fromTopics = shared.length >= 2 || (shared.length && audience.length && forMe) ? bandFor(100) : shared.length === 1 ? bandFor(65) : bandFor(0);
    const fit = betterBand(bandFor(similarity), fromTopics);
    const reasons = [];
    if (audience.length && forMe) reasons.push(`For ${me.department} staff`);
    if (shared.length) reasons.push(`Matches your interest in ${shared.slice(0, 2).join(' and ').toLowerCase()}`);
    const rank = (similarity ?? 50) + 8 * shared.length + (audience.length && forMe ? 10 : 0) - (forMe ? 0 : 15);
    return { ...e, topics_list: splitList(e.topics, 6, 30), audience: audience, for_me: Boolean(forMe), fit, fit_reasons: reasons, rank };
  });
}

module.exports = { opportunityText, eventText, annotateOpportunities, annotateEvents, memberProfile };
