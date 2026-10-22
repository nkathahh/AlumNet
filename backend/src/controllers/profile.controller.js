const pool = require('../config/db');

const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?$/;

// Limits keep the profile tidy and stop oversized input reaching the database
const LIMITS = { headline: 120, bio: 2000, skills: 1000, experience: 3000, careerInterests: 1000, city: 100, country: 100 };

async function getMyProfile(req, res, next) {
  try {
    const { userId, role } = req.user;
    const [[profile]] = await pool.execute(
      `SELECT p.skills, p.experience, p.career_interests, p.industry, p.headline, p.bio, p.linkedin_url,
              u.name, u.email, u.department, u.city, u.country, u.created_at, u.onboarded_at, u.staff_number,
              sd.employment_status,
              mt.years_of_experience
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.user_id
       LEFT JOIN mentors mt ON mt.user_id = u.user_id
       LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
       WHERE u.user_id = :userId`,
      { userId }
    );
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const { staff_number: staffNumber, employment_status: employmentStatus, ...rest } = profile;
    // "Verified" means the account is linked to an HR record
    res.json({ ...rest, role, verified: Boolean(staffNumber && employmentStatus), employment_status: employmentStatus || null });
  } catch (err) {
    next(err);
  }
}

function clean(value) {
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

// Only fields sent in the request are changed, so a partial save never wipes other fields
async function updateMyProfile(req, res, next) {
  try {
    const { userId, role } = req.user;
    const body = req.body || {};
    const values = {
      skills: clean(body.skills),
      experience: clean(body.experience),
      careerInterests: clean(body.careerInterests),
      industry: clean(body.industry),
      headline: clean(body.headline),
      bio: clean(body.bio),
      linkedinUrl: clean(body.linkedinUrl),
      city: clean(body.city),
      country: clean(body.country)
    };

    for (const [key, max] of Object.entries(LIMITS)) {
      if (values[key] && values[key].length > max) {
        return res.status(400).json({ error: `${key} must be ${max} characters or fewer` });
      }
    }
    if (values.linkedinUrl && !LINKEDIN_RE.test(values.linkedinUrl)) {
      return res.status(400).json({ error: 'Enter a LinkedIn profile link like https://www.linkedin.com/in/your-name' });
    }

    let years;
    if (body.yearsOfExperience !== undefined && role === 'mentor') {
      years = body.yearsOfExperience === '' || body.yearsOfExperience === null ? null : Number(body.yearsOfExperience);
      if (years !== null && (!Number.isInteger(years) || years < 0 || years > 60)) {
        return res.status(400).json({ error: 'Years of experience must be a whole number between 0 and 60' });
      }
    }

    const profileColumns = {
      skills: 'skills', experience: 'experience', careerInterests: 'career_interests', industry: 'industry',
      headline: 'headline', bio: 'bio', linkedinUrl: 'linkedin_url'
    };
    const sets = Object.entries(profileColumns)
      .filter(([key]) => values[key] !== undefined)
      .map(([key, column]) => `${column} = :${key}`);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      if (sets.length) {
        // Create the profile row if an older account never had one
        await connection.execute('INSERT IGNORE INTO profiles (user_id) VALUES (:userId)', { userId });
        await connection.execute(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = :userId`, { ...values, userId });
      }
      const userSets = ['city', 'country'].filter((k) => values[k] !== undefined).map((k) => `${k} = :${k}`);
      if (userSets.length) {
        await connection.execute(`UPDATE users SET ${userSets.join(', ')} WHERE user_id = :userId`, { ...values, userId });
      }
      if (years !== undefined) {
        await connection.execute('UPDATE mentors SET years_of_experience = :years WHERE user_id = :userId', { years, userId });
      }
      // The welcome wizard marks the account as onboarded (also when skipped)
      if (body.completeOnboarding === true) {
        await connection.execute('UPDATE users SET onboarded_at = COALESCE(onboarded_at, NOW()) WHERE user_id = :userId', { userId });
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// What other members see: no email, phone or ID details. Mentor profiles are
// visible to all members; a mentee's profile only to mentors they have
// contacted, and to admins.
async function getPublicProfile(req, res, next) {
  try {
    const { id } = req.params;
    const { userId: viewerId, role: viewerRole } = req.user;
    const [[profile]] = await pool.execute(
      `SELECT u.user_id, u.name, u.department, u.city, u.country,
              p.headline, p.bio, p.linkedin_url, p.skills, p.experience, p.career_interests, p.industry,
              mt.years_of_experience, sd.employment_status,
              CASE WHEN sd.employment_status = 'former' THEN 'mentor'
                   WHEN sd.employment_status = 'active' THEN 'mentee'
                   WHEN mt.user_id IS NOT NULL THEN 'mentor' ELSE 'mentee' END AS role
       FROM users u
       JOIN profiles p ON p.user_id = u.user_id
       LEFT JOIN mentors mt ON mt.user_id = u.user_id
       LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
       WHERE u.user_id = :id AND u.status = 'active'`,
      { id }
    );
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (profile.role === 'mentee' && viewerRole !== 'admin' && Number(id) !== viewerId) {
      const [[link]] = await pool.execute(
        'SELECT request_id FROM mentorship_requests WHERE mentee_id = :id AND mentor_id = :viewerId LIMIT 1',
        { id, viewerId }
      );
      if (!link) return res.status(404).json({ error: 'Profile not found' });
    }

    const { employment_status: status, ...rest } = profile;
    res.json({
      ...rest,
      verified: Boolean(status),
      verified_label: status === 'former' ? 'Verified former KQ staff' : status === 'active' ? 'Verified current KQ staff' : null
    });
  } catch (err) { next(err); }
}

module.exports = { getMyProfile, updateMyProfile, getPublicProfile };
