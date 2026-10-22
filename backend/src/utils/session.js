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

function signSession({ userId, role, sessionVersion }) {
  return jwt.sign(
    { userId, role, sv: sessionVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
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

module.exports = { COOKIE_NAME, parseCookies, setSessionCookie, clearSessionCookie, readSessionToken };
