const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/db');
const { sendMail, emailLayout } = require('../utils/mailer');
const { createNotification } = require('../utils/notify');

const SALT_ROUNDS = 10;
const RESET_TOKEN_MINUTES = 30;
const USERNAME_RE = /^[a-z0-9._]{3,30}$/;

// Accept codes from the previous and next 30-second window as well,
// so a slightly slow phone clock does not lock people out
authenticator.options = { window: 1 };

const googleClient = new OAuth2Client();

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

// Short-lived token proving the password (or Google) step passed,
// used only to complete the two-factor step
function signTwoFactorToken(userId) {
  return jwt.sign({ userId, purpose: '2fa' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password must include both letters and numbers';
  return null;
}

function normaliseUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function validateUsername(username) {
  if (!USERNAME_RE.test(username)) {
    return 'Username must be 3 to 30 characters: lowercase letters, numbers, dots or underscores';
  }
  return null;
}

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
}

async function resolveRole(userId) {
  const [[mentee]] = await pool.execute('SELECT user_id FROM mentees WHERE user_id = :userId', { userId });
  if (mentee) return 'mentee';
  const [[mentor]] = await pool.execute('SELECT user_id FROM mentors WHERE user_id = :userId', { userId });
  if (mentor) return 'mentor';
  return 'admin';
}

// Final step of every successful sign-in: either ask for the 2FA code
// or issue the real session token
async function completeSignIn(user, res) {
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended. Contact an administrator.' });
  }
  if (user.totp_enabled) {
    return res.json({ twoFactorRequired: true, tempToken: signTwoFactorToken(user.user_id) });
  }
  const role = await resolveRole(user.user_id);
  const token = signToken({ userId: user.user_id, role });
  return res.json({ token, userId: user.user_id, role });
}

/* ------------------------------------------------------------------
   Registration
   ------------------------------------------------------------------ */

async function register(req, res, next) {
  const {
    email, password, role, staffNumber, mobileNumber, country, city,
    skills, experience, careerInterests, industry
  } = req.body;
  const username = normaliseUsername(req.body.username);

  if (!password || !role || !staffNumber || !country || !city || !username) {
    return res.status(400).json({ error: 'username, password, role, staffNumber, country and city are required' });
  }
  if (!['mentee', 'mentor'].includes(role)) {
    return res.status(400).json({ error: "role must be 'mentee' or 'mentor'" });
  }
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  try {
    const [[taken]] = await pool.execute('SELECT user_id FROM users WHERE username = :username', { username });
    if (taken) return res.status(409).json({ error: 'That username is already taken' });

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
           (name, email, username, password_hash, id_number, staff_number, mobile_number, country, city, department)
         VALUES (:name, :email, :username, :passwordHash, :idNumber, :staffNumber, :mobileNumber, :country, :city, :department)`,
        {
          name: staff.full_name, email: finalEmail, username, passwordHash,
          idNumber: staff.id_number, staffNumber, mobileNumber: mobileNumber || staff.mobile_number || null,
          country, city, department: staff.department
        }
      );
      const userId = userResult.insertId;

      if (role === 'mentee') {
        await connection.execute('INSERT INTO mentees (user_id) VALUES (:userId)', { userId });
      } else {
        await connection.execute(
          'INSERT INTO mentors (user_id, years_of_experience) VALUES (:userId, :years)',
          { userId, years: req.body.yearsOfExperience || null }
        );
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
        return res.status(409).json({ error: 'An account for this staff number, email or username already exists' });
      }
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    next(err);
  }
}

async function usernameAvailable(req, res, next) {
  const username = normaliseUsername(req.query.username);
  const error = validateUsername(username);
  if (error) return res.json({ available: false, reason: error });
  try {
    const [[taken]] = await pool.execute('SELECT user_id FROM users WHERE username = :username', { username });
    res.json({ available: !taken, reason: taken ? 'That username is already taken' : null });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
   Sign-in: email or username, Google, and the two-factor step
   ------------------------------------------------------------------ */

async function login(req, res, next) {
  // "identifier" can be an email or a username; "email" is still accepted
  const identifier = String(req.body.identifier || req.body.email || '').trim();
  const { password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email or username and password are required' });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE email = :identifier OR username = :username LIMIT 1',
      { identifier, username: identifier.toLowerCase() }
    );
    const user = rows[0];
    // Same message for an unknown account and a wrong password, so the
    // form cannot be used to discover which accounts exist
    if (!user) return res.status(401).json({ error: 'Invalid email, username or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email, username or password' });

    return completeSignIn(user, res);
  } catch (err) {
    next(err);
  }
}

async function verifyGoogleCredential(credential) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    const err = new Error('Google sign-in is not configured');
    err.status = 503;
    throw err;
  }
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload || !payload.email_verified) {
    const err = new Error('Your Google email address is not verified');
    err.status = 401;
    throw err;
  }
  return payload;
}

async function googleLogin(req, res, next) {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

  let payload;
  try {
    payload = await verifyGoogleCredential(credential);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.status ? err.message : 'Google sign-in failed. Please try again.' });
  }

  try {
    // Prefer an explicitly linked Google account, then fall back to a matching email
    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE google_id = :sub OR email = :email ORDER BY (google_id = :sub) DESC LIMIT 1',
      { sub: payload.sub, email: payload.email }
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({
        error: 'No AlumNet account uses this Google account. Sign up with your staff number first, or log in and link Google in Account settings.'
      });
    }
    if (!user.google_id) {
      await pool.execute('UPDATE users SET google_id = :sub WHERE user_id = :userId', { sub: payload.sub, userId: user.user_id });
    }
    return completeSignIn(user, res);
  } catch (err) {
    next(err);
  }
}

async function verifyTwoFactor(req, res, next) {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.status(400).json({ error: 'Code is required' });

  let decoded;
  try {
    decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    if (decoded.purpose !== '2fa') throw new Error('wrong purpose');
  } catch {
    return res.status(401).json({ error: 'Your sign-in session expired. Please log in again.' });
  }

  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE user_id = :userId', { userId: decoded.userId });
    if (!user || !user.totp_enabled || !user.totp_secret) {
      return res.status(401).json({ error: 'Two-factor authentication is not set up for this account' });
    }
    const valid = authenticator.verify({ token: String(code).replace(/\s/g, ''), secret: user.totp_secret });
    if (!valid) return res.status(401).json({ error: 'That code is incorrect or has expired' });
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'This account has been suspended. Contact an administrator.' });
    }

    const role = await resolveRole(user.user_id);
    res.json({ token: signToken({ userId: user.user_id, role }), userId: user.user_id, role });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
   Forgot, reset and change password
   ------------------------------------------------------------------ */

async function forgotPassword(req, res, next) {
  const identifier = String(req.body.identifier || req.body.email || '').trim();
  // Always the same reply, whether or not the account exists
  const reply = { message: 'If an account matches, a reset link has been sent to its email address.' };
  if (!identifier) return res.status(400).json({ error: 'Enter your email or username' });

  try {
    const [rows] = await pool.execute(
      'SELECT user_id, name, email, status FROM users WHERE email = :identifier OR username = :username LIMIT 1',
      { identifier, username: identifier.toLowerCase() }
    );
    const user = rows[0];
    if (!user || user.status === 'suspended') return res.json(reply);

    // Only the newest link should work
    await pool.execute(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL',
      { userId: user.user_id }
    );

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.execute(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES (:userId, :tokenHash, DATE_ADD(NOW(), INTERVAL ${RESET_TOKEN_MINUTES} MINUTE))`,
      { userId: user.user_id, tokenHash }
    );

    const link = `${appUrl()}/reset-password.html?token=${token}`;
    const firstName = (user.name || '').split(' ')[0] || 'there';
    try {
      await sendMail({
        to: user.email,
        subject: 'Reset your AlumNet password',
        text: `Hi ${firstName},\n\nUse this link to reset your AlumNet password. It expires in ${RESET_TOKEN_MINUTES} minutes and can only be used once:\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
        html: emailLayout('Reset your password', `
          <p>Hi ${firstName},</p>
          <p>Use the button below to reset your AlumNet password. The link expires in ${RESET_TOKEN_MINUTES} minutes and can only be used once.</p>
          <p style="margin:24px 0;"><a href="${link}" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Reset password</a></p>
          <p style="font-size:13px;color:#45524C;">Or paste this link into your browser:<br>${link}</p>`)
      });
    } catch (mailErr) {
      // A mail failure must not reveal anything to the user; log it for the developer
      console.error('Password reset email failed:', mailErr.message);
      console.log(`Reset link for ${user.email}: ${link}`);
    }
    res.json(reply);
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  const { token, password } = req.body;
  if (!token) return res.status(400).json({ error: 'This reset link is invalid' });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const [[reset]] = await pool.execute(
      `SELECT reset_id, user_id FROM password_resets
       WHERE token_hash = :tokenHash AND used_at IS NULL AND expires_at > NOW()`,
      { tokenHash }
    );
    if (!reset) return res.status(400).json({ error: 'This reset link has expired or has already been used. Request a new one.' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await pool.execute(
      'UPDATE users SET password_hash = :passwordHash, password_changed_at = NOW() WHERE user_id = :userId',
      { passwordHash, userId: reset.user_id }
    );
    await pool.execute('UPDATE password_resets SET used_at = NOW() WHERE reset_id = :resetId', { resetId: reset.reset_id });
    await createNotification(reset.user_id, 'security', 'Your password was reset. If this was not you, contact an administrator.', 'settings.html');

    res.json({ message: 'Your password has been reset. You can now log in.' });
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'The new password must be different from the current one' });
  }

  try {
    const [[user]] = await pool.execute('SELECT password_hash FROM users WHERE user_id = :userId', { userId: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Your current password is incorrect' });

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.execute(
      'UPDATE users SET password_hash = :passwordHash, password_changed_at = NOW() WHERE user_id = :userId',
      { passwordHash, userId: req.user.userId }
    );
    await createNotification(req.user.userId, 'security', 'Your password was changed.', 'settings.html');
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
   Account settings: username, two-factor and Google linking
   ------------------------------------------------------------------ */

async function getAccount(req, res, next) {
  try {
    const [[user]] = await pool.execute(
      'SELECT name, email, username, totp_enabled, google_id, password_changed_at, created_at FROM users WHERE user_id = :userId',
      { userId: req.user.userId }
    );
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json({
      name: user.name,
      email: user.email,
      username: user.username,
      role: req.user.role,
      twoFactorEnabled: Boolean(user.totp_enabled),
      googleLinked: Boolean(user.google_id),
      passwordChangedAt: user.password_changed_at,
      createdAt: user.created_at
    });
  } catch (err) {
    next(err);
  }
}

async function updateUsername(req, res, next) {
  const username = normaliseUsername(req.body.username);
  const error = validateUsername(username);
  if (error) return res.status(400).json({ error });
  try {
    const [[taken]] = await pool.execute(
      'SELECT user_id FROM users WHERE username = :username AND user_id != :userId',
      { username, userId: req.user.userId }
    );
    if (taken) return res.status(409).json({ error: 'That username is already taken' });
    await pool.execute('UPDATE users SET username = :username WHERE user_id = :userId', { username, userId: req.user.userId });
    res.json({ username });
  } catch (err) {
    next(err);
  }
}

async function setupTwoFactor(req, res, next) {
  try {
    const [[user]] = await pool.execute('SELECT email, totp_enabled FROM users WHERE user_id = :userId', { userId: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Account not found' });
    if (user.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is already on' });

    // Stored now but only switched on once the user proves the app works
    const secret = authenticator.generateSecret();
    await pool.execute('UPDATE users SET totp_secret = :secret WHERE user_id = :userId', { secret, userId: req.user.userId });

    const otpauthUrl = authenticator.keyuri(user.email, 'AlumNet', secret);
    const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
    res.json({ qr, secret });
  } catch (err) {
    next(err);
  }
}

async function enableTwoFactor(req, res, next) {
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!code) return res.status(400).json({ error: 'Enter the 6-digit code from your app' });
  try {
    const [[user]] = await pool.execute('SELECT totp_secret, totp_enabled FROM users WHERE user_id = :userId', { userId: req.user.userId });
    if (!user || !user.totp_secret) return res.status(400).json({ error: 'Start the setup again' });
    if (user.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is already on' });
    if (!authenticator.verify({ token: code, secret: user.totp_secret })) {
      return res.status(400).json({ error: 'That code is incorrect. Check the time on your phone and try again.' });
    }
    await pool.execute('UPDATE users SET totp_enabled = 1 WHERE user_id = :userId', { userId: req.user.userId });
    await createNotification(req.user.userId, 'security', 'Two-factor authentication was turned on for your account.', 'settings.html');
    res.json({ twoFactorEnabled: true });
  } catch (err) {
    next(err);
  }
}

async function disableTwoFactor(req, res, next) {
  const { password } = req.body;
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!password || !code) return res.status(400).json({ error: 'Your password and a current code are required' });
  try {
    const [[user]] = await pool.execute(
      'SELECT password_hash, totp_secret, totp_enabled FROM users WHERE user_id = :userId',
      { userId: req.user.userId }
    );
    if (!user || !user.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is not on' });
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Your password is incorrect' });
    }
    if (!authenticator.verify({ token: code, secret: user.totp_secret })) {
      return res.status(401).json({ error: 'That code is incorrect or has expired' });
    }
    await pool.execute('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE user_id = :userId', { userId: req.user.userId });
    await createNotification(req.user.userId, 'security', 'Two-factor authentication was turned off for your account.', 'settings.html');
    res.json({ twoFactorEnabled: false });
  } catch (err) {
    next(err);
  }
}

async function linkGoogle(req, res, next) {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

  let payload;
  try {
    payload = await verifyGoogleCredential(credential);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.status ? err.message : 'Google verification failed' });
  }

  try {
    const [[other]] = await pool.execute(
      'SELECT user_id FROM users WHERE google_id = :sub AND user_id != :userId',
      { sub: payload.sub, userId: req.user.userId }
    );
    if (other) return res.status(409).json({ error: 'This Google account is already linked to another AlumNet account' });
    await pool.execute('UPDATE users SET google_id = :sub WHERE user_id = :userId', { sub: payload.sub, userId: req.user.userId });
    res.json({ googleLinked: true, googleEmail: payload.email });
  } catch (err) {
    next(err);
  }
}

async function unlinkGoogle(req, res, next) {
  try {
    await pool.execute('UPDATE users SET google_id = NULL WHERE user_id = :userId', { userId: req.user.userId });
    res.json({ googleLinked: false });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
   Staff directory lookup (used during sign-up)
   ------------------------------------------------------------------ */

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

module.exports = {
  register, usernameAvailable, login, googleLogin, verifyTwoFactor,
  forgotPassword, resetPassword, changePassword,
  getAccount, updateUsername, setupTwoFactor, enableTwoFactor, disableTwoFactor,
  linkGoogle, unlinkGoogle, staffLookup,
  // exported for tests
  validatePassword, validateUsername
};
