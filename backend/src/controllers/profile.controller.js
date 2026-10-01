const pool = require('../config/db');

async function getMyProfile(req, res, next) {
    try {
        const { userId } = req.user;
        const [[profile]] = await pool.execute(
            `SELECT p.skills, p.experience, p.career_interests, p.industry, u.name, u.email, u.department
   FROM profiles p JOIN users u ON u.user_id = p.user_id
   WHERE p.user_id = :userId`,
            { userId }
        );
        if (!profile) return res.status(404).json({ error: 'Profile not found' });
        res.json(profile);
    } catch (err) {
        next(err);
    }
}

async function updateMyProfile(req, res, next) {
    try {
        const { userId } = req.user;
        const { skills, experience, careerInterests, industry } = req.body;
        await pool.execute(
            `UPDATE profiles
       SET skills = :skills, experience = :experience, career_interests = :careerInterests, industry = :industry
       WHERE user_id = :userId`,
            { userId, skills: skills || null, experience: experience || null, careerInterests: careerInterests || null, industry: industry || null }
        );
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

module.exports = { getMyProfile, updateMyProfile };