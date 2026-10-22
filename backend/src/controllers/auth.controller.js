const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/db');
const { sendMail, emailLayout } = require('../utils/mailer');
const { createNotification } = require('../utils/notify');
const { setSessionCookie, clearSessionCookie } = require('../utils/session');
const { normaliseStaffNumber, normaliseEmail, findStaff, hrEmailFor, roleForStaff, canJoin, resolveRole, endOpenMentorships } = require('../utils/hr');
const { assessSignup } = require('../utils/risk');

const SALT_ROUNDS = 10;
const RESET_TOKEN_MINUTES = 30;
const SIGNUP_LINK_HOURS = 24;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STAFF_RE = /^[A-Z0-9]{3,20}$/;

// Accept codes from the previous and next 30-second window as well,
// so a slightly slow phone clock does not lock people out
authenticator.options = { window: 1 };

const googleClient = new OAuth2Client();

/* ------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------ */

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

function signTwoFactorToken(userId) {
  return jwt.sign({ userId, purpose: '2fa' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Password must include both letters and numbers';
  return null;
}

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
}

function firstName(name) {
  return (String(name || '').split(' ')[0]) || 'there';
}

async function needsOnboarding(userId, role) {
  if (role === 'admin') return false;
  const [[u]] = await pool.execute('SELECT onboarded_at FROM users WHERE user_id = :userId', { userId });
  return !u || !u.onboarded_at;
}

// Final step of every successful sign-in: ask for the 2FA code if it is on,
// otherwise sync the role with HR and start the session
async function completeSignIn(req, res, user) {
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'This account is not active. Contact the alumni office.' });
  }
  if (user.staff_number) {
    const staff = await findStaff(user.staff_number);
    if (staff && !staff.alumni_eligible) {
      return res.status(403).json({ error: 'This account is not active. Contact the alumni office.' });
    }
  }
  if (user.totp_enabled) {
    return res.json({ twoFactorRequired: true, tempToken: signTwoFactorToken(user.user_id) });
  }
  return startSession(req, res, user.user_id);
}

async function startSession(req, res, userId) {
  const role = await resolveRole(userId);
  if (!role) return res.status(403).json({ error: 'This account has no role yet. Contact the alumni office.' });
  const [[u]] = await pool.execute('SELECT session_version FROM users WHERE user_id = :userId', { userId });
  await pool.execute('UPDATE users SET last_login_at = NOW() WHERE user_id = :userId', { userId });
  setSessionCookie(req, res, { userId, role, sessionVersion: u.session_version });
  return res.json({ role, onboardingRequired: await needsOnboarding(userId, role) });
}

// Ends every session for this user (used after password changes and on request)
async function bumpSessionVersion(userId) {
  await pool.execute('UPDATE users SET session_version = session_version + 1 WHERE user_id = :userId', { userId });
}

// Creates a verified account from an HR record, in one transaction
async function createAccount({ staff, email, passwordHash, googleId = null, privacyAcceptedAt = null }) {
  const role = roleForStaff(staff);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO users (name, email, password_hash, staff_number, department, google_id,
                          country, email_verified_at, privacy_accepted_at)
       VALUES (:name, :email, :passwordHash, :staffNumber, :department, :googleId, 'Kenya', NOW(), :privacy)`,
      {
        name: staff.full_name, email, passwordHash, staffNumber: staff.staff_number,
        department: staff.department, googleId, privacy: privacyAcceptedAt || new Date()
      }
    );
    const userId = result.insertId;
    await conn.execute(`INSERT INTO ${role === 'mentor' ? 'mentors' : 'mentees'} (user_id) VALUES (:userId)`, { userId });
    await conn.execute('INSERT INTO profiles (user_id) VALUES (:userId)', { userId });
    await conn.commit();
    return { userId, role };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function accountExists({ staffNumber, email }) {
  const [rows] = await pool.execute(
    'SELECT user_id FROM users WHERE staff_number = :staffNumber OR email = :email LIMIT 1',
    { staffNumber, email }
  );
  return rows.length > 0;
}

async function verifyGoogleCredential(credential) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    const err = new Error('Google sign-in is not configured');
    err.status = 503;
    throw err;
  }
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    const err = new Error('Google sign-in failed. Please try again.');
    err.status = 401;
    throw err;
  }
  if (!payload || !payload.email_verified) {
    const err = new Error('Your Google email address is not verified');
    err.status = 401;
    throw err;
  }
  return payload;
}

/* ------------------------------------------------------------------
   Sign-up step 1: staff number and email
   The reply is identical whatever is entered, so nobody can use this
   form to find out whether a staff number exists or what email HR holds.
   ------------------------------------------------------------------ */

async function signupStart(req, res, next) {
  const staffNumber = normaliseStaffNumber(req.body.staffNumber);
  const email = normaliseEmail(req.body.email);
  if (!STAFF_RE.test(staffNumber)) return res.status(400).json({ error: 'Enter your staff number, for example KQ48213' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (req.body.acceptPrivacy !== true) return res.status(400).json({ error: 'Please read and accept the privacy notice to continue' });

  const reply = { message: 'Check your email. If your details can be used to register, we have sent you a link to continue.' };

  try {
    // Quietly cap repeated attempts for one email or staff number
    const [[{ recent }]] = await pool.execute(
      `SELECT COUNT(*) AS recent FROM signup_requests
       WHERE (email = :email OR staff_number = :staffNumber) AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
      { email, staffNumber }
    );
    if (recent >= 3) return res.json(reply);

    // Someone who already has an account gets a reminder instead of a new account
    const [[existing]] = await pool.execute('SELECT user_id, name FROM users WHERE email = :email', { email });
    if (existing) {
      const link = `${appUrl()}/login.html`;
      await sendMail({
        to: email,
        subject: 'You already have an AlumNet account',
        text: `Hi ${firstName(existing.name)},\n\nSomeone (hopefully you) tried to register with this email, but it already has an AlumNet account. Log in here: ${link}\n\nForgot your password? Use "Forgot password" on the login page.`,
        html: emailLayout('You already have an account', `<p>Hi ${firstName(existing.name)},</p><p>Someone (hopefully you) tried to register with this email, but it already has an AlumNet account.</p><p style="margin:24px 0;"><a href="${link}" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Log in</a></p><p style="font-size:13px;color:#45524C;">Forgot your password? Use "Forgot password" on the login page.</p>`)
      }).catch((e) => console.error('Email failed:', e.message));
      return res.json(reply);
    }

    const staff = await findStaff(staffNumber);
    const hrMatch = canJoin(staff) && hrEmailFor(staff) === email && !(await accountExists({ staffNumber, email }));

    // Older unused links for this email stop working
    await pool.execute(
      `UPDATE signup_requests SET status = 'expired' WHERE email = :email AND status = 'awaiting_email'`,
      { email }
    );
    const token = newToken();
    await pool.execute(
      `INSERT INTO signup_requests (staff_number, email, token_hash, hr_match, ip_address, privacy_accepted_at, expires_at)
       VALUES (:staffNumber, :email, :tokenHash, :hrMatch, :ip, NOW(), DATE_ADD(NOW(), INTERVAL ${SIGNUP_LINK_HOURS} HOUR))`,
      { staffNumber, email, tokenHash: sha256(token), hrMatch: hrMatch ? 1 : 0, ip: req.ip || null }
    );

    const link = `${appUrl()}/signup.html?token=${token}`;
    await sendMail({
      to: email,
      subject: 'Confirm your email to join AlumNet',
      text: `Hello,\n\nConfirm your email to continue registering for AlumNet, the Kenya Airways alumni network. This link works once and expires in ${SIGNUP_LINK_HOURS} hours:\n\n${link}\n\nIf you did not try to register, ignore this email.`,
      html: emailLayout('Confirm your email', `<p>Hello,</p><p>Confirm your email to continue registering for AlumNet, the Kenya Airways alumni network. The link works once and expires in ${SIGNUP_LINK_HOURS} hours.</p><p style="margin:24px 0;"><a href="${link}" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Continue registration</a></p><p style="font-size:13px;color:#45524C;">If you did not try to register, ignore this email.</p>`)
    }).catch((e) => console.error('Email failed:', e.message));

    res.json(reply);
  } catch (err) {
    next(err);
  }
}

async function findOpenSignup(token) {
  if (!token) return null;
  const [[request]] = await pool.execute(
    `SELECT * FROM signup_requests
     WHERE token_hash = :tokenHash AND status = 'awaiting_email' AND expires_at > NOW()`,
    { tokenHash: sha256(token) }
  );
  return request || null;
}

/* ------------------------------------------------------------------
   Sign-up step 2: the link from the email (proves they own the address)
   ------------------------------------------------------------------ */

async function signupLink(req, res, next) {
  try {
    const request = await findOpenSignup(req.query.token);
    if (!request) return res.status(400).json({ error: 'This link has expired or has already been used. Start again to get a new one.' });

    await pool.execute(
      'UPDATE signup_requests SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE request_id = :id',
      { id: request.request_id }
    );

    if (request.hr_match) {
      const staff = await findStaff(request.staff_number);
      if (canJoin(staff) && !(await accountExists({ staffNumber: staff.staff_number, email: request.email }))) {
        // Only now, after the person proved they own the HR email, do we show their name
        return res.json({
          state: 'set_password',
          name: staff.full_name,
          role: roleForStaff(staff),
          department: staff.department,
          email: request.email
        });
      }
    }
    res.json({ state: 'details_required', email: request.email });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
   Sign-up step 3a: verified automatically, choose a password or Google
   ------------------------------------------------------------------ */

async function signupComplete(req, res, next) {
  const { token, password, googleCredential } = req.body;
  try {
    const request = await findOpenSignup(token);
    if (!request || !request.hr_match) {
      return res.status(400).json({ error: 'This link has expired or has already been used. Start again to get a new one.' });
    }
    const staff = await findStaff(request.staff_number);
    if (!canJoin(staff) || await accountExists({ staffNumber: staff.staff_number, email: request.email })) {
      return res.status(400).json({ error: 'This registration can no longer be completed. Contact the alumni office.' });
    }

    let passwordHash;
    let googleId = null;
    if (googleCredential) {
      const payload = await verifyGoogleCredential(googleCredential).catch((e) => ({ error: e }));
      if (payload.error) return res.status(payload.error.status || 401).json({ error: payload.error.message });
      const [[taken]] = await pool.execute('SELECT user_id FROM users WHERE google_id = :sub', { sub: payload.sub });
      if (taken) return res.status(409).json({ error: 'This Google account is already linked to another AlumNet account' });
      googleId = payload.sub;
      // A random password nobody knows; they can set one later with "Forgot password"
      passwordHash = await bcrypt.hash(newToken(), SALT_ROUNDS);
    } else {
      const problem = validatePassword(password);
      if (problem) return res.status(400).json({ error: problem });
      passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    }

    const { userId } = await createAccount({
      staff, email: request.email, passwordHash, googleId, privacyAcceptedAt: request.privacy_accepted_at
    });
    await pool.execute(`UPDATE signup_requests SET status = 'completed' WHERE request_id = :id`, { id: request.request_id });
    return startSession(req, res, userId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An account already exists for these details. Try logging in.' });
    next(err);
  }
}

/* ------------------------------------------------------------------
   Sign-up step 3b: could not verify automatically, so the alumni office
   reviews it with the evidence already compared
   ------------------------------------------------------------------ */

async function signupRequestReview(req, res, next) {
  const { token, fullName, phone, password } = req.body;
  try {
    const request = await findOpenSignup(token);
    if (!request) return res.status(400).json({ error: 'This link has expired or has already been used. Start again to get a new one.' });

    const name = String(fullName || '').trim();
    if (name.split(/\s+/).length < 2 || name.length > 150) return res.status(400).json({ error: 'Enter your full name as HR knows it' });
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) return res.status(400).json({ error: 'Enter a phone number we can reach you on, for example 0712 345 678' });
    const problem = validatePassword(password);
    if (problem) return res.status(400).json({ error: problem });

    const staff = await findStaff(request.staff_number);
    const [[{ attempts }]] = await pool.execute(
      `SELECT COUNT(*) AS attempts FROM signup_requests
       WHERE staff_number = :staffNumber AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      { staffNumber: request.staff_number }
    );
    const [[byStaff]] = await pool.execute('SELECT user_id FROM users WHERE staff_number = :s', { s: request.staff_number });
    const [[byEmail]] = await pool.execute('SELECT user_id FROM users WHERE email = :e', { e: request.email });
    const risk = assessSignup({ fullName: name, phone, email: request.email }, staff, {
      alreadyRegistered: Boolean(byStaff), recentAttempts: attempts, emailInUse: Boolean(byEmail)
    });

    await pool.execute(
      `UPDATE signup_requests
       SET status = 'pending_review', full_name = :name, phone = :phone, password_hash = :hash,
           risk_level = :level, risk_signals = :signals, email_verified_at = COALESCE(email_verified_at, NOW()),
           expires_at = DATE_ADD(NOW(), INTERVAL 30 DAY)
       WHERE request_id = :id`,
      {
        name, phone: String(phone).trim(), hash: await bcrypt.hash(password, SALT_ROUNDS),
        level: risk.level, signals: JSON.stringify({ suggestion: risk.suggestion, signals: risk.signals }), id: request.request_id
      }
    );

    // Tell the admins there is something to review
    const [admins] = await pool.query('SELECT user_id FROM admins');
    for (const a of admins) {
      await createNotification(a.user_id, 'signup_review', `New sign-up to verify: ${name} (${request.staff_number}).`, 'admin.html#verification');
    }

    res.json({ message: 'Thank you. The alumni office will verify your details and email you, usually within two working days.' });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
   Sign-in: email and password, Google, then two-factor if switched on
   ------------------------------------------------------------------ */

async function login(req, res, next) {
  const email = normaliseEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE email = :email', { email });
    // Same message for an unknown email and a wrong password
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    return completeSignIn(req, res, user);
  } catch (err) {
    next(err);
  }
}

async function googleLogin(req, res, next) {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });
  try {
    const payload = await verifyGoogleCredential(credential).catch((e) => ({ error: e }));
    if (payload.error) return res.status(payload.error.status || 401).json({ error: payload.error.message });

    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE google_id = :sub OR email = :email ORDER BY (google_id = :sub) DESC LIMIT 1',
      { sub: payload.sub, email: normaliseEmail(payload.email) }
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({
        error: 'No AlumNet account uses this Google account. Register with your staff number first, or log in and link Google in Account settings.'
      });
    }
    if (!user.google_id) {
      await pool.execute('UPDATE users SET google_id = :sub WHERE user_id = :userId', { sub: payload.sub, userId: user.user_id });
    }
    return completeSignIn(req, res, user);
  } catch (err) {
    next(err);
  }
}

// A code from the authenticator app, or a one-time backup code
async function checkSecondFactor(user, rawCode) {
  const code = String(rawCode || '').trim();
  const digits = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    return authenticator.verify({ token: digits, secret: user.totp_secret }) ? { ok: true } : { ok: false };
  }
  const normalised = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalised.length !== 10) return { ok: false };
  const [result] = await pool.execute(
    `UPDATE two_factor_backup_codes SET used_at = NOW()
     WHERE user_id = :userId AND code_hash = :hash AND used_at IS NULL`,
    { userId: user.user_id, hash: sha256(normalised) }
  );
  if (result.affectedRows !== 1) return { ok: false };
  const [[{ remaining }]] = await pool.execute(
    'SELECT COUNT(*) AS remaining FROM two_factor_backup_codes WHERE user_id = :userId AND used_at IS NULL',
    { userId: user.user_id }
  );
  await createNotification(user.user_id, 'security', `A backup code was used to sign in. ${remaining} backup code${remaining === 1 ? '' : 's'} left.`, 'settings.html');
  return { ok: true, backupCodeUsed: true, backupCodesLeft: remaining };
}

async function verifyTwoFactor(req, res, next) {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) return res.status(400).json({ error: 'Enter your code' });

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
    if (user.status !== 'active') return res.status(403).json({ error: 'This account is not active. Contact the alumni office.' });
    const check = await checkSecondFactor(user, code);
    if (!check.ok) return res.status(401).json({ error: 'That code is incorrect or has expired' });
    return startSession(req, res, user.user_id);
  } catch (err) {
    next(err);
  }
}

async function logout(req, res) {
  clearSessionCookie(req, res);
  res.json({ message: 'Logged out' });
}

async function logoutEverywhere(req, res, next) {
  try {
    await bumpSessionVersion(req.user.userId);
    clearSessionCookie(req, res);
    res.json({ message: 'Logged out on all devices' });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
   Forgot, reset and change password
   ------------------------------------------------------------------ */

async function forgotPassword(req, res, next) {
  const email = normaliseEmail(req.body.email);
  const reply = { message: 'If an account uses this email, we have sent it a reset link.' };
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter your email address' });

  try {
    const [[user]] = await pool.execute(
      `SELECT user_id, name, email FROM users WHERE email = :email AND status = 'active'`,
      { email }
    );
    if (!user) return res.json(reply);

    await pool.execute(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = :userId AND used_at IS NULL',
      { userId: user.user_id }
    );
    const token = newToken();
    await pool.execute(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES (:userId, :tokenHash, DATE_ADD(NOW(), INTERVAL ${RESET_TOKEN_MINUTES} MINUTE))`,
      { userId: user.user_id, tokenHash: sha256(token) }
    );

    const link = `${appUrl()}/reset-password.html?token=${token}`;
    await sendMail({
      to: user.email,
      subject: 'Reset your AlumNet password',
      text: `Hi ${firstName(user.name)},\n\nUse this link to reset your AlumNet password. It expires in ${RESET_TOKEN_MINUTES} minutes and can only be used once:\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      html: emailLayout('Reset your password', `
        <p>Hi ${firstName(user.name)},</p>
        <p>Use the button below to reset your AlumNet password. The link expires in ${RESET_TOKEN_MINUTES} minutes and can only be used once.</p>
        <p style="margin:24px 0;"><a href="${link}" style="background:#C8102E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Reset password</a></p>
        <p style="font-size:13px;color:#45524C;">If you did not ask for this, you can ignore this email.</p>`)
    }).catch((e) => console.error('Password reset email failed:', e.message));
    res.json(reply);
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  const { token, password } = req.body;
  if (!token) return res.status(400).json({ error: 'This reset link is invalid' });
  const problem = validatePassword(password);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const [[reset]] = await pool.execute(
      `SELECT reset_id, user_id FROM password_resets
       WHERE token_hash = :tokenHash AND used_at IS NULL AND expires_at > NOW()`,
      { tokenHash: sha256(token) }
    );
    if (!reset) return res.status(400).json({ error: 'This reset link has expired or has already been used. Request a new one.' });

    await pool.execute(
      `UPDATE users SET password_hash = :hash, password_changed_at = NOW(), session_version = session_version + 1
       WHERE user_id = :userId`,
      { hash: await bcrypt.hash(password, SALT_ROUNDS), userId: reset.user_id }
    );
    await pool.execute('UPDATE password_resets SET used_at = NOW() WHERE reset_id = :id', { id: reset.reset_id });
    await createNotification(reset.user_id, 'security', 'Your password was reset and you were logged out on other devices. If this was not you, contact the alumni office.', 'settings.html');
    res.json({ message: 'Your password has been reset. You can now log in.' });
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
  const problem = validatePassword(newPassword);
  if (problem) return res.status(400).json({ error: problem });
  if (currentPassword === newPassword) return res.status(400).json({ error: 'The new password must be different from the current one' });

  try {
    const [[user]] = await pool.execute('SELECT password_hash FROM users WHERE user_id = :userId', { userId: req.user.userId });
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: 'Your current password is incorrect' });
    }
    await pool.execute(
      `UPDATE users SET password_hash = :hash, password_changed_at = NOW(), session_version = session_version + 1
       WHERE user_id = :userId`,
      { hash: await bcrypt.hash(newPassword, SALT_ROUNDS), userId: req.user.userId }
    );
    await createNotification(req.user.userId, 'security', 'Your password was changed and you were logged out on other devices.', 'settings.html');
    // Keep this device signed in with a fresh session
    const [[u]] = await pool.execute('SELECT session_version FROM users WHERE user_id = :userId', { userId: req.user.userId });
    setSessionCookie(req, res, { userId: req.user.userId, role: req.user.role, sessionVersion: u.session_version });
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
   Account settings
   ------------------------------------------------------------------ */

async function getAccount(req, res, next) {
  try {
    const [[user]] = await pool.execute(
      `SELECT u.name, u.email, u.department, u.totp_enabled, u.google_id, u.password_changed_at, u.created_at,
              sd.employment_status,
              (SELECT COUNT(*) FROM two_factor_backup_codes b WHERE b.user_id = u.user_id AND b.used_at IS NULL) AS backup_codes_left
       FROM users u LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
       WHERE u.user_id = :userId`,
      { userId: req.user.userId }
    );
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json({
      name: user.name,
      email: user.email,
      department: user.department,
      role: req.user.role,
      verified: Boolean(user.employment_status),
      employmentStatus: user.employment_status,
      twoFactorEnabled: Boolean(user.totp_enabled),
      backupCodesLeft: user.backup_codes_left,
      googleLinked: Boolean(user.google_id),
      passwordChangedAt: user.password_changed_at,
      createdAt: user.created_at
    });
  } catch (err) {
    next(err);
  }
}

async function makeBackupCodes(userId) {
  await pool.execute('DELETE FROM two_factor_backup_codes WHERE user_id = :userId', { userId });
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const raw = crypto.randomBytes(8).toString('hex').slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    await pool.execute(
      'INSERT INTO two_factor_backup_codes (user_id, code_hash) VALUES (:userId, :hash)',
      { userId, hash: sha256(raw) }
    );
  }
  return codes;
}

async function setupTwoFactor(req, res, next) {
  try {
    const [[user]] = await pool.execute('SELECT email, totp_enabled FROM users WHERE user_id = :userId', { userId: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Account not found' });
    if (user.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is already on' });

    // Stored now but only switched on once the user proves the app works
    const secret = authenticator.generateSecret();
    await pool.execute('UPDATE users SET totp_secret = :secret WHERE user_id = :userId', { secret, userId: req.user.userId });
    const qr = await QRCode.toDataURL(authenticator.keyuri(user.email, 'AlumNet', secret), { margin: 1, width: 220 });
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
    const backupCodes = await makeBackupCodes(req.user.userId);
    await createNotification(req.user.userId, 'security', 'Two-factor authentication was turned on for your account.', 'settings.html');
    res.json({ twoFactorEnabled: true, backupCodes });
  } catch (err) {
    next(err);
  }
}

async function regenerateBackupCodes(req, res, next) {
  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE user_id = :userId', { userId: req.user.userId });
    if (!user.totp_enabled) return res.status(400).json({ error: 'Turn on two-factor authentication first' });
    if (!(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
      return res.status(400).json({ error: 'Your password is incorrect' });
    }
    const backupCodes = await makeBackupCodes(user.user_id);
    await createNotification(user.user_id, 'security', 'New backup codes were created. Your old ones no longer work.', 'settings.html');
    res.json({ backupCodes });
  } catch (err) {
    next(err);
  }
}

async function disableTwoFactor(req, res, next) {
  const { password, code } = req.body;
  if (!password || !code) return res.status(400).json({ error: 'Your password and a current code are required' });
  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE user_id = :userId', { userId: req.user.userId });
    if (!user || !user.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is not on' });
    if (!(await bcrypt.compare(password, user.password_hash))) return res.status(400).json({ error: 'Your password is incorrect' });
    const check = await checkSecondFactor(user, code);
    if (!check.ok) return res.status(400).json({ error: 'That code is incorrect or has expired' });
    await pool.execute('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE user_id = :userId', { userId: user.user_id });
    await pool.execute('DELETE FROM two_factor_backup_codes WHERE user_id = :userId', { userId: user.user_id });
    await createNotification(user.user_id, 'security', 'Two-factor authentication was turned off for your account.', 'settings.html');
    res.json({ twoFactorEnabled: false });
  } catch (err) {
    next(err);
  }
}

async function linkGoogle(req, res, next) {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });
  try {
    const payload = await verifyGoogleCredential(credential).catch((e) => ({ error: e }));
    if (payload.error) return res.status(payload.error.status || 401).json({ error: payload.error.message });
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
   Data rights (Kenya Data Protection Act): download and delete
   ------------------------------------------------------------------ */

async function exportMyData(req, res, next) {
  const { userId } = req.user;
  try {
    const [[account]] = await pool.execute(
      `SELECT name, email, department, city, country, status, created_at, last_login_at,
              privacy_accepted_at, totp_enabled, (google_id IS NOT NULL) AS google_linked
       FROM users WHERE user_id = :userId`,
      { userId }
    );
    const [[profile]] = await pool.execute(
      'SELECT headline, bio, skills, experience, career_interests, industry, linkedin_url FROM profiles WHERE user_id = :userId',
      { userId }
    );
    const [mentorships] = await pool.execute(
      `SELECT r.status, r.requested_at, r.ended_at,
              CASE WHEN r.mentee_id = :userId THEN 'mentee' ELSE 'mentor' END AS your_side,
              u.name AS other_person
       FROM mentorship_requests r
       JOIN users u ON u.user_id = IF(r.mentee_id = :userId, r.mentor_id, r.mentee_id)
       WHERE r.mentee_id = :userId OR r.mentor_id = :userId`,
      { userId }
    );
    const [events] = await pool.execute(
      `SELECT e.title, e.event_date, er.registered_at FROM event_registrations er
       JOIN events e ON e.event_id = er.event_id WHERE er.user_id = :userId`,
      { userId }
    );
    const [opportunities] = await pool.execute(
      'SELECT title, company, approval_status, created_at FROM career_opportunities WHERE posted_by = :userId',
      { userId }
    );
    const [notifications] = await pool.execute(
      'SELECT type, message, is_read, created_at FROM notifications WHERE user_id = :userId ORDER BY created_at DESC',
      { userId }
    );
    res.setHeader('Content-Disposition', 'attachment; filename="alumnet-my-data.json"');
    res.json({
      exported_at: new Date().toISOString(),
      account: { ...account, totp_enabled: Boolean(account.totp_enabled), google_linked: Boolean(account.google_linked) },
      profile: profile || {},
      mentorships,
      event_registrations: events,
      opportunities_posted: opportunities,
      notifications
    });
  } catch (err) {
    next(err);
  }
}

async function deleteMyAccount(req, res, next) {
  const { userId, role } = req.user;
  const { password, code } = req.body;
  if (role === 'admin') return res.status(400).json({ error: 'Admin accounts are removed by another administrator.' });
  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE user_id = :userId', { userId });
    if (!(await bcrypt.compare(String(password || ''), user.password_hash))) {
      return res.status(400).json({ error: 'Your password is incorrect' });
    }
    if (user.totp_enabled) {
      const check = await checkSecondFactor(user, code);
      if (!check.ok) return res.status(400).json({ error: 'Enter a current two-factor code to confirm' });
    }

    const conn = await pool.getConnection();
    let ended = [];
    try {
      await conn.beginTransaction();
      ended = ended.concat(await endOpenMentorships(conn, userId, 'mentee', 'deleted'));
      ended = ended.concat(await endOpenMentorships(conn, userId, 'mentor', 'deleted'));
      await conn.execute('DELETE FROM event_registrations WHERE user_id = :userId', { userId });
      await conn.execute('DELETE FROM notifications WHERE user_id = :userId', { userId });
      await conn.execute('DELETE FROM two_factor_backup_codes WHERE user_id = :userId', { userId });
      await conn.execute('DELETE FROM password_resets WHERE user_id = :userId', { userId });
      await conn.execute(
        `UPDATE profiles SET skills = NULL, experience = NULL, career_interests = NULL, industry = NULL,
                headline = NULL, bio = NULL, linkedin_url = NULL, gender = NULL, gender_in_search = 0 WHERE user_id = :userId`,
        { userId }
      );
      // Embeddings are worked out from the profile, so they are personal data too
      await conn.execute('DELETE FROM profile_embeddings WHERE user_id = :userId', { userId });
      await conn.execute(
        'UPDATE mentors SET availability_note = NULL, accepting_mentees = 0 WHERE user_id = :userId',
        { userId }
      );
      // The row stays so other people's history still makes sense, but holds nothing personal
      await conn.execute(
        `UPDATE users SET name = 'Deleted member', email = :email, password_hash = :hash, staff_number = NULL,
                city = NULL, country = NULL, google_id = NULL, totp_secret = NULL, totp_enabled = 0,
                status = 'deleted', session_version = session_version + 1
         WHERE user_id = :userId`,
        { email: `deleted-${userId}@deleted.invalid`, hash: await bcrypt.hash(newToken(), SALT_ROUNDS), userId }
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    for (const e of ended) {
      await createNotification(e.otherId, 'mentorship_ended', 'A member you were connected with has deleted their account, so the mentorship has closed.', 'requests.html');
    }
    clearSessionCookie(req, res);
    res.json({ message: 'Your account and personal data have been deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  signupStart, signupLink, signupComplete, signupRequestReview,
  login, googleLogin, verifyTwoFactor, logout, logoutEverywhere,
  forgotPassword, resetPassword, changePassword,
  getAccount, setupTwoFactor, enableTwoFactor, regenerateBackupCodes, disableTwoFactor,
  linkGoogle, unlinkGoogle, exportMyData, deleteMyAccount,
  // shared with the admin controller and tests
  createAccount, validatePassword
};
