const pool = require('../config/db');
const { scanPost } = require('../utils/scam');
const { chooseLane, finishSubmission } = require('../utils/moderation');
const { splitList } = require('../utils/fit');
const { annotateOpportunities } = require('../utils/recommend');
const { reviewEdit } = require('../utils/liveEdit');
const { checkText } = require('../utils/fields');
const logAdminAction = (...args) => require('./admin.controller').logAdminAction(...args);

// Up to 8 skills, so the checklist stays readable
function cleanSkills(text) {
  const raw = String(text || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  if (raw.length > 8) return { error: 'List up to 8 required skills' };
  if (raw.some((x) => x.length > 40)) return { error: 'Keep each skill under 40 characters' };
  return { value: splitList(text, 8, 40).join(', ') || null };
}

const OPPORTUNITY_TYPES = ['full_time', 'part_time', 'contract', 'consultancy', 'internal_transfer', 'volunteer'];

function validateOpportunityInput(body) {
  const { title, company, opportunityType, description, applyLink, closingDate, requiredSkills } = body;
  const wrongSize = checkText(body, 'opportunity');
  if (wrongSize) return wrongSize;
  if (!title || !title.trim()) return 'Title is required';
  const skills = cleanSkills(requiredSkills);
  if (skills.error) return skills.error;
  if (!company || !company.trim()) return 'Company or department is required';
  if (!OPPORTUNITY_TYPES.includes(opportunityType)) return 'Choose a valid opportunity type';
  if (!description || !description.trim()) return 'A description is required';

  if (!applyLink || !applyLink.trim()) return 'An application link or contact email is required';
  const link = applyLink.trim();
  const isUrl = /^https?:\/\/\S+$/i.test(link);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(link);
  // Only web links and emails are allowed, so nothing unsafe can be rendered as a link
  if (!isUrl && !isEmail) {
    return 'Application link must start with http:// or https://, or be an email address';
  }

  if (!closingDate || !/^\d{4}-\d{2}-\d{2}$/.test(closingDate)) return 'A closing date is required';
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  if (closingDate < today) return 'Closing date cannot be in the past';
  return null;
}

// Approved opportunities that haven't closed yet, newest first
async function listOpportunities(req, res, next) {
  try {
    const [rows] = await pool.execute(
      `SELECT co.opportunity_id, co.title, co.description, co.required_skills, co.industry, co.company,
              co.opportunity_type, co.location, co.apply_link, DATE_FORMAT(co.closing_date, '%Y-%m-%d') AS closing_date, co.created_at, co.edited_at,
              co.posted_by, (co.posted_by = :userId) AS is_mine,
              u.name AS posted_by_name, u.department AS posted_by_department
       FROM career_opportunities co
       JOIN users u ON u.user_id = co.posted_by
       WHERE co.approval_status = 'approved'
         AND (co.closing_date IS NULL OR co.closing_date >= CURDATE())
         AND co.closed_at IS NULL
       ORDER BY co.created_at DESC`,
      { userId: req.user.userId }
    );
    const list = rows.map((r) => ({ ...r, is_mine: Number(r.is_mine) === 1 }));
    // Current staff see how well each one fits them, and why
    if (req.user.role === 'mentee') return res.json(await annotateOpportunities(req.user.userId, list));
    res.json(list);
  } catch (err) {
    next(err);
  }
}

// Mentors post opportunities; they wait for admin approval
async function createOpportunity(req, res, next) {
  try {
    const { userId, role } = req.user;
    if (role !== 'mentor') {
      return res.status(403).json({ error: 'Only alumni can post career opportunities' });
    }
    const error = validateOpportunityInput(req.body);
    if (error) return res.status(400).json({ error });

    const { title, company, opportunityType, industry, location, description, applyLink, closingDate } = req.body;
    const requiredSkills = cleanSkills(req.body.requiredSkills).value;
    const scan = scanPost({ title, description, company, location, link: applyLink });
    const routed = await chooseLane('opportunity', { userId, title, link: applyLink }, scan);
    const [result] = await pool.execute(
      `INSERT INTO career_opportunities
         (posted_by, title, description, required_skills, industry, company, opportunity_type, location, apply_link, closing_date, approval_status, risk_level, risk_flags, submitted_at)
       VALUES
         (:userId, :title, :description, :requiredSkills, :industry, :company, :opportunityType, :location, :applyLink, :closingDate, 'pending', :riskLevel, :riskFlags, NOW())`,
      {
        userId,
        title: title.trim(),
        description: description.trim(),
        requiredSkills,
        industry: industry || null,
        company: company.trim(),
        opportunityType,
        location: location ? location.trim() : null,
        applyLink: applyLink.trim(),
        closingDate,
        riskLevel: scan.level,
        riskFlags: JSON.stringify(scan.flags)
      }
    );
    const reply = await finishSubmission('opportunity', result.insertId, routed, scan);
    res.status(201).json({ opportunityId: result.insertId, ...reply });
  } catch (err) {
    next(err);
  }
}

/*
 * Editing a post. Before review the edit replaces it and goes through the
 * checks again. A live post (say the closing date is extended) stays live
 * when the checks find nothing and the link is unchanged or on a known site;
 * otherwise it goes back to the alumni office, so an approved post cannot be
 * swapped for a scam afterwards.
 */
async function updateOpportunity(req, res, next) {
  try {
    const { userId } = req.user;
    const id = Number(req.params.id);
    const [[post]] = await pool.execute(
      'SELECT approval_status, apply_link, closed_at FROM career_opportunities WHERE opportunity_id = :id AND posted_by = :userId',
      { id, userId }
    );
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.closed_at) return res.status(409).json({ error: 'This post was closed' });
    if (!['changes_requested', 'pending', 'approved'].includes(post.approval_status)) {
      return res.status(409).json({ error: 'This post can no longer be edited' });
    }
    const error = validateOpportunityInput(req.body);
    if (error) return res.status(400).json({ error });

    const { title, company, opportunityType, industry, location, description, applyLink, closingDate } = req.body;
    const requiredSkills = cleanSkills(req.body.requiredSkills).value;
    const scan = scanPost({ title, description, company, location, link: applyLink });
    const fields = {
      id, title: title.trim(), description: description.trim(), requiredSkills, industry: industry || null, company: company.trim(),
      opportunityType, location: location ? location.trim() : null, applyLink: applyLink.trim(), closingDate,
      riskLevel: scan.level, riskFlags: JSON.stringify(scan.flags)
    };
    const setFields = `title = :title, description = :description, required_skills = :requiredSkills, industry = :industry, company = :company,
         opportunity_type = :opportunityType, location = :location, apply_link = :applyLink, closing_date = :closingDate,
         risk_level = :riskLevel, risk_flags = :riskFlags`;

    if (post.approval_status === 'approved') {
      const review = await reviewEdit('opportunity', { userId, id, title, oldLink: post.apply_link, newLink: applyLink }, scan);
      if (review.stayLive) {
        await pool.execute(`UPDATE career_opportunities SET ${setFields}, edited_at = NOW() WHERE opportunity_id = :id`, fields);
        await logAdminAction(null, 'live_edit', 'career_opportunities', id,
          `Live opportunity "${fields.title}" was edited by its poster and stayed live after the checks`, fields.title);
        return res.json({ opportunityId: id, published: true, needsCloserReview: false, warnings: [], message: 'Saved. Your post is updated.' });
      }
      await pool.execute(
        `UPDATE career_opportunities SET ${setFields}, approval_status = 'pending', submitted_at = NOW(), reviewed_at = NULL, edited_at = NOW()
         WHERE opportunity_id = :id`, fields
      );
      const reply = await finishSubmission('opportunity', id, review.routed, scan);
      return res.json({ opportunityId: id, ...reply, message: reply.needsCloserReview ? reply.message : 'Saved. Because of what changed, the alumni office will check it before it is live again.' });
    }

    const resubmitting = post.approval_status === 'changes_requested';
    const routed = await chooseLane('opportunity', { userId, title, link: applyLink, isResubmission: resubmitting, excludeId: id }, scan);
    await pool.execute(
      `UPDATE career_opportunities SET ${setFields}, approval_status = 'pending',
         submitted_at = IF(:resubmitting, NOW(), submitted_at), reviewed_at = NULL WHERE opportunity_id = :id`,
      { ...fields, resubmitting: resubmitting ? 1 : 0 }
    );
    res.json({ opportunityId: id, ...(await finishSubmission('opportunity', id, routed, scan)) });
  } catch (err) {
    next(err);
  }
}

// The role was filled: the poster closes it early and it leaves the list
async function closeOpportunity(req, res, next) {
  try {
    const [result] = await pool.execute(
      `UPDATE career_opportunities SET closed_at = NOW() WHERE opportunity_id = :id AND posted_by = :userId AND closed_at IS NULL`,
      { id: Number(req.params.id), userId: req.user.userId }
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Post not found' });
    res.json({ message: 'Closed. It no longer shows in the list.' });
  } catch (err) {
    next(err);
  }
}

// A mentor's own posts, with their review status
async function listMyPosts(req, res, next) {
  try {
    const { userId } = req.user;
    const [rows] = await pool.execute(
      `SELECT opportunity_id, title, company, approval_status, DATE_FORMAT(closing_date, '%Y-%m-%d') AS closing_date, rejection_reason, review_note, edited_at, closed_at,
              opportunity_type, industry, location, apply_link, description, required_skills
       FROM career_opportunities WHERE posted_by = :userId
       ORDER BY created_at DESC`,
      { userId }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { listOpportunities, createOpportunity, updateOpportunity, closeOpportunity, listMyPosts };