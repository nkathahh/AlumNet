const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const SALT_ROUNDS = 10;

async function register(req, res, next) {
  const {
    name, email, password, role,
    idNumber, staffNumber, mobileNumber, country, city,
    skills, experience, careerInterests, industry
  } = req.body;

  if (!name || !email || !password || !role || !idNumber || !country || !city) {
    return res.status(400).json({ error: 'name, email, password, role, idNumber, country and city are required' });
  }
  if (!['mentee', 'mentor'].includes(role)) {
    return res.status(400).json({ error: "role must be 'mentee' or 'mentor'" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const [userResult] = await connection.execute(
      `INSERT INTO users
         (name, email, password_hash, id_number, staff_number, mobile_number, country, city)
       VALUES (:name, :email, :passwordHash, :idNumber, :staffNumber, :mobileNumber, :country, :city)`,
      { name, email, passwordHash, idNumber, staffNumber: staffNumber || null, mobileNumber: mobileNumber || null, country, city }
    );
    const userId = userResult.insertId;

    if (role === 'mentee') {
      await connection.execute('INSERT INTO mentees (user_id) VALUES (:userId)', { userId });
    } else {
      await connection.execute('INSERT INTO mentors (user_id) VALUES (:userId)', { userId });
    }

    await connection.execute(
      `INSERT INTO profiles (user_id, skills, experience, career_interests, industry)
       VALUES (:userId, :skills, :experience, :careerInterests, :industry)`,
      { userId, skills: skills || null, experience: experience || null, careerInterests: careerInterests || null, industry: industry || null }
    );

    await connection.commit();

    const token = signToken({ userId, role });
    res.status(201).json({ token, userId, role });
  } catch (err) {
    await connection.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An account with that email or ID number already exists' });
    }
    next(err);
  } finally {
    connection.release();
  }
}

async function login(req, res, next) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE email = :email', { email });
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const role = await resolveRole(user.user_id);
    const token = signToken({ userId: user.user_id, role });
    res.json({ token, userId: user.user_id, role });
  } catch (err) {
    next(err);
  }
}

async function resolveRole(userId) {
  const [[mentee]] = await pool.execute('SELECT user_id FROM mentees WHERE user_id = :userId', { userId });
  if (mentee) return 'mentee';
  const [[mentor]] = await pool.execute('SELECT user_id FROM mentors WHERE user_id = :userId', { userId });
  if (mentor) return 'mentor';
  return 'admin';
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

module.exports = { register, login };