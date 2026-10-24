const jwt = require('jsonwebtoken');

// The login session lives in an HttpOnly cookie, so page scripts (and any
// injected script) can never read it. SameSite=Lax stops other sites from
// sending it with their requests.
const COOKIE_NAME = 'alumnet_session';

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function cookieFlags(req, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' || req.secure;
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : null,
    `Max-Age=${maxAgeSeconds}`
  ].filter(Boolean).join('; ');
}

/*
 * How long a session lasts. Admin sessions end after 30 minutes without use
 * and 12 hours after signing in, because an admin session left open on a
 * shared computer can do the most harm. Members stay signed in for 14 days
 * of inactivity, and at most 30 days, before signing in again.
 */
const SESSION_LIMITS = {
  admin: { idleSeconds: 30 * 60, maxSeconds: 12 * 3600 },
  member: { idleSeconds: 14 * 24 * 3600, maxSeconds: 30 * 24 * 3600 }
};
const limitsFor = (role) => (role === 'admin' ? SESSION_LIMITS.admin : SESSION_LIMITS.member);
// A session is re-issued at most this often, so not every request sets a cookie
const REFRESH_AFTER_SECONDS = 5 * 60;

// at = when they signed in (kept on refresh), act = last activity
function signSession({ userId, role, sessionVersion, at }) {
  const now = Math.floor(Date.now() / 1000);
  const signedInAt = at || now;
  const { idleSeconds, maxSeconds } = limitsFor(role);
  const exp = Math.min(now + idleSeconds, signedInAt + maxSeconds);
  return jwt.sign({ userId, role, sv: sessionVersion || 0, at: signedInAt, act: now, exp }, process.env.JWT_SECRET);
}

function setSessionCookie(req, res, user) {
  const token = signSession(user);
  const { exp } = jwt.decode(token);
  const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
  res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieFlags(req, maxAge)}`);
}

function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieFlags(req, 0)}`);
}

function readSessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

module.exports = { COOKIE_NAME, SESSION_LIMITS, REFRESH_AFTER_SECONDS, limitsFor, parseCookies, setSessionCookie, clearSessionCookie, readSessionToken };
