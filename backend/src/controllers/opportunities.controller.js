const pool = require('../config/db');
const { scanPost } = require('../utils/scam');

const OPPORTUNITY_TYPES = ['full_time', 'part_time', 'contract', 'consultancy', 'internal_transfer', 'volunteer'];

function validateOpportunityInput({ title, company, opportunityType, description, applyLink, closingDate }) {
  if (!title || !title.trim()) return 'Title is required';
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
      `SELECT co.opportunity_id, co.title, co.description, co.industry, co.company,
              co.opportunity_type, co.location, co.apply_link, co.closing_date, co.created_at,
              u.name AS posted_by_name, u.department AS posted_by_department
       FROM career_opportunities co
       JOIN users u ON u.user_id = co.posted_by
       WHERE co.approval_status = 'approved'
         AND (co.closing_date IS NULL OR co.closing_date >= CURDATE())
       ORDER BY co.created_at DESC`
    );
    res.json(rows);
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
    const scan = scanPost({ title, description, company, location, link: applyLink });
    const [result] = await pool.execute(
      `INSERT INTO career_opportunities
         (posted_by, title, description, industry, company, opportunity_type, location, apply_link, closing_date, approval_status, risk_level, risk_flags)
       VALUES
         (:userId, :title, :description, :industry, :company, :opportunityType, :location, :applyLink, :closingDate, 'pending', :riskLevel, :riskFlags)`,
      {
        userId,
        title: title.trim(),
        description: description.trim(),
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
    // The poster sees the same warnings the admin will, so honest mistakes can be fixed
    res.status(201).json({ opportunityId: result.insertId, message: 'Submitted for review',
      // A high-risk post gets a general notice only, so scammers cannot learn which words to change
      needsCloserReview: scan.level === 'high',
      warnings: scan.level === 'high' ? [] : scan.flags.map((f) => f.label) });
  } catch (err) {
    next(err);
  }
}

// A mentor's own posts, with their review status
async function listMyPosts(req, res, next) {
  try {
    const { userId } = req.user;
    const [rows] = await pool.execute(
      `SELECT opportunity_id, title, company, approval_status, closing_date
       FROM career_opportunities WHERE posted_by = :userId
       ORDER BY created_at DESC`,
      { userId }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { listOpportunities, createOpportunity, listMyPosts };