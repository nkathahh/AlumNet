const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const SALT_ROUNDS = 10;

async function register(req, res, next) {
  const {
    email, password, role, staffNumber, mobileNumber, country, city,
    skills, experience, careerInterests, industry
  } = req.body;

  if (!password || !role || !staffNumber || !country || !city) {
    return res.status(400).json({ error: 'password, role, staffNumber, country and city are required' });
  }
  if (!['mentee', 'mentor'].includes(role)) {
    return res.status(400).json({ error: "role must be 'mentee' or 'mentor'" });
  }

  const [[staff]] = await pool.execute(
    'SELECT * FROM staff_directory WHERE staff_number = :staffNumber',
    { staffNumber }
  );
  if (!staff) return res.status(404).json({ error: 'Staff number not found' });

  if (role === 'mentee' && staff.employment_status !== 'active') {
    return res.status(400).json({ error: 'Only current employees can register as mentees' });
  }

  const finalEmail = role === 'mentee' ? staff.kq_email : email;
  if (!finalEmail) {
    return res.status(400).json({ error: role === 'mentee' ? 'No Kenya Airways email on record for this staff number' : 'Personal email is required' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const [userResult] = await connection.execute(
      `INSERT INTO users
         (name, email, password_hash, id_number, staff_number, mobile_number, country, city, department)
       VALUES (:name, :email, :passwordHash, :idNumber, :staffNumber, :mobileNumber, :country, :city, :department)`,
      {
        name: staff.full_name, email: finalEmail, passwordHash,
        idNumber: staff.id_number, staffNumber, mobileNumber: mobileNumber || staff.mobile_number || null,
        country, city, department: staff.department
      }
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
      return res.status(409).json({ error: 'An account for this staff number or email already exists' });
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
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'This account has been suspended. Contact an administrator.' });
    }

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
async function staffLookup(req, res, next) {
  const { staffNumber } = req.query;
  if (!staffNumber) return res.status(400).json({ error: 'staffNumber is required' });
  try {
    const [[staff]] = await pool.execute(
      `SELECT full_name, id_number, mobile_number, department, kq_email, employment_status
       FROM staff_directory WHERE staff_number = :staffNumber`,
      { staffNumber }
    );
    if (!staff) return res.status(404).json({ error: 'Staff number not found' });
    res.json(staff);
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, staffLookup };