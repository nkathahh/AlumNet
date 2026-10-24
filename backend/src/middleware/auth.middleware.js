const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { readSessionToken, clearSessionCookie, setSessionCookie, limitsFor, REFRESH_AFTER_SECONDS } = require('../utils/session');
const { PRIVACY_VERSION } = require('../utils/privacy');

/*
 * What a member can still do before accepting a changed privacy notice:
 * accept it, see their account, download their data, delete their account
 * or sign out everywhere. Declining the new notice must never trap their data.
 */
const PRIVACY_EXEMPT = new Set([
  'POST /api/auth/privacy',
  'GET /api/auth/account',
  'GET /api/auth/account/export',
  'POST /api/auth/account/delete',
  'POST /api/auth/logout-everywhere'
]);

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/*
 * CSRF protection: every state-changing API call must carry a custom header.
 * Browsers will not let another website add custom headers to a request to
 * AlumNet, so a forged form or link from elsewhere is rejected.
 */
function requireAppHeader(req, res, next) {
  if (UNSAFE.has(req.method) && req.get('X-Requested-With') !== 'AlumNet') {
    return res.status(403).json({ error: 'Request blocked for security reasons. Reload the page and try again.' });
  }
  next();
}

/*
 * Checks the session cookie on every request, then the database: a
 * suspended, deleted or no-longer-eligible account, or a session ended by
 * "log out everywhere" or a password change, stops working immediately.
 */
async function requireAuth(req, res, next) {
  const token = readSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Please log in' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    clearSessionCookie(req, res);
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
  // Special-purpose tokens (such as the two-factor step) are not sessions
  if (decoded.purpose || !decoded.userId) return res.status(401).json({ error: 'Please log in' });

  try {
    const [[u]] = await pool.execute(
      `SELECT u.status, u.session_version, u.totp_enabled, u.privacy_version, sd.alumni_eligible
       FROM users u LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
       WHERE u.user_id = :userId`,
      { userId: decoded.userId }
    );
    const ended = !u || u.status !== 'active' || u.alumni_eligible === 0 || u.session_version !== (decoded.sv || 0);
    if (ended) {
      clearSessionCookie(req, res);
      return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
    }
    // Too long since signing in (the idle limit is the token's own expiry)
    const now = Math.floor(Date.now() / 1000);
    const signedInAt = decoded.at || decoded.iat || now;
    if (now - signedInAt > limitsFor(decoded.role).maxSeconds) {
      clearSessionCookie(req, res);
      return res.status(401).json({ error: 'For your security, please log in again.' });
    }
    // Still in use: extend the idle limit. The background check for new
    // notifications does not count, so an open but unused tab still times out.
    const passive = req.method === 'GET' && /\/notifications\/unread-count$/.test(req.originalUrl.split('?')[0]);
    if (!passive && now - (decoded.act || decoded.iat || 0) > REFRESH_AFTER_SECONDS) {
      setSessionCookie(req, res, { userId: decoded.userId, role: decoded.role, sessionVersion: u.session_version, at: signedInAt });
    }
    req.user = { userId: decoded.userId, role: decoded.role, twoFactorEnabled: Boolean(u.totp_enabled) };
    // The privacy notice changed since they last accepted it
    if (u.privacy_version !== PRIVACY_VERSION && !PRIVACY_EXEMPT.has(`${req.method} ${req.originalUrl.split('?')[0]}`)) {
      return res.status(403).json({
        code: 'privacy_update',
        version: PRIVACY_VERSION,
        error: 'The privacy notice has changed. Please read and accept it to carry on.'
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Admin tools need two-factor authentication. Set ADMIN_2FA_REQUIRED=false
// only for local development.
function requireAdminTwoFactor(req, res, next) {
  if (process.env.ADMIN_2FA_REQUIRED === 'false' || req.user.twoFactorEnabled) return next();
  return res.status(403).json({
    code: 'two_factor_required',
    error: 'Turn on two-factor authentication in Account settings to use the admin tools.'
  });
}

module.exports = { requireAppHeader, requireAuth, requireRole, requireAdminTwoFactor };
