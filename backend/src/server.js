require('dotenv').config();
require('./config/checkSecrets').checkSecrets();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const profileRoutes = require('./routes/profile.routes');
const mentorshipRoutes = require('./routes/mentorship.routes');
const eventRoutes = require('./routes/events.routes');
const opportunityRoutes = require('./routes/opportunities.routes');
const adminRoutes = require('./routes/admin.routes');
const recommendationRoutes = require('./routes/recommendations.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const { requireAppHeader } = require('./middleware/auth.middleware');
const pool = require('./config/db');

// Errors that mean the database cannot be reached at all (NFR-05)
const DB_DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST', 'ER_CON_COUNT_ERROR']);

const app = express();

// Needed behind a hosting proxy so rate limiting sees real client addresses
app.set('trust proxy', 1);

/*
 * Behind the Cloudflare gateway (see gateway/proxy.js), requests must carry
 * the shared GATEWAY_SECRET. The backend's own address on Hugging Face is
 * public, so without this anyone could skip the gateway. The gateway also
 * passes on the visitor's real address, which rate limits and sign-up checks
 * use; it can only be trusted because the secret proves where it came from.
 * Without GATEWAY_SECRET (on a laptop or in the tests) nothing changes.
 */
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || '';
if (GATEWAY_SECRET) {
  const crypto = require('crypto');
  const net = require('net');
  const expected = crypto.createHash('sha256').update(GATEWAY_SECRET).digest();
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const supplied = crypto.createHash('sha256').update(req.get('x-alumnet-gateway') || '').digest();
    if (!crypto.timingSafeEqual(supplied, expected)) {
      return res.status(403).json({ error: 'Open AlumNet from its main address.' });
    }
    const ip = String(req.get('x-client-ip') || '').trim();
    if (net.isIP(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    next();
  });
}

// Security headers on every response. The content security policy only
// allows scripts from AlumNet itself and Google's sign-in, so injected
// script from anywhere else cannot run.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    // Inline styles stay allowed (the pages use style attributes); they cannot run script
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "font-src 'self'",
    // Every image comes from AlumNet itself (blob: is the preview before an upload)
    "img-src 'self' data: blob:",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Sign-in and reset links carry one-time tokens, so never pass page addresses on to other sites
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// The frontend is served by this same server, so no cross-origin access is
// needed. CORS_ORIGIN can allow a separately hosted frontend.
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
if (allowedOrigins.length) app.use(cors({ origin: allowedOrigins, credentials: true }));

// HR imports can be larger than normal requests
app.use('/api/admin/hr', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '100kb' }));
app.use('/api', requireAppHeader);
app.use('/api', require('./utils/rateLimit').writeLimit);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Public, non-secret settings the frontend needs
app.get('/api/config', async (req, res) => {
  let brand = null;
  try { brand = await require('./controllers/images.controller').brandInfo(); } catch { /* the logo is optional */ }
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null, brand });
});
// The organisation's logo is shown before signing in, so it is served to everyone
app.get('/brand/:file', require('./controllers/images.controller').serveBrand);

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/mentorship-requests', mentorshipRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/safety', require('./routes/safety.routes'));
app.use('/api/mentors', require('./routes/mentors.routes'));
app.use('/api/images', require('./routes/images.routes'));

// Image files, for signed-in members only (each request checks who may see the image)
app.get('/media/:file', require('./middleware/auth.middleware').requireAuth, require('./controllers/images.controller').serveMedia);

// Unknown API routes return JSON, not an HTML page
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the frontend from the same server: open http://localhost:4000
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend', 'public');
app.get('/', (req, res) => res.redirect('/login.html'));
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid. Reload the page and try again.' });
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: req.path.startsWith('/api/images') ? 'That image is over 5 MB. Choose a smaller one.' : 'That is too much data to send at once.' });
  }
  console.error(err);
  // Safety net behind the field checks: the database refused a value that is
  // too long or the wrong kind. The member is told to fix their input rather
  // than seeing a server error; the log above still shows it, so the missing
  // check can be added.
  if (['ER_DATA_TOO_LONG', 'ER_TRUNCATED_WRONG_VALUE', 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', 'WARN_DATA_TRUNCATED', 'ER_WARN_DATA_OUT_OF_RANGE'].includes(err.code)) {
    return res.status(400).json({ error: 'One of the fields is too long or not in the right format. Shorten it and try again.' });
  }
  // The database is unreachable (powered off, restarting or a network fault).
  // That is not the member's fault and passes on its own: say so plainly with a
  // 503 so pages can show a calm "reconnecting" notice, not a generic error.
  if (!err.isAxiosError && (DB_DOWN_CODES.has(err.code) || err.fatal)) {
    return res.status(503).json({ code: 'db_unavailable', error: 'AlumNet cannot reach its database right now. It reconnects by itself; please try again in a minute.' });
  }
  const status = err.status || 500;
  // Do not leak internal error details to users in production
  const message = status < 500 || process.env.NODE_ENV !== 'production'
    ? (err.message || 'Internal server error')
    : 'Something went wrong. Please try again.';
  res.status(status).json({ error: message });
});

// Data retention: remove sign-up attempts and reset links that are no longer needed
async function cleanUpOldRecords() {
  try {
    await pool.query(`UPDATE signup_requests SET status = 'expired' WHERE status IN ('awaiting_email','pending_review') AND expires_at < NOW()`);
    await pool.query(`DELETE FROM signup_requests WHERE status IN ('expired','rejected','completed','approved') AND created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    await pool.query('DELETE FROM password_resets WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)');
    await require('./controllers/mentorship.controller').expireStaleRequests();
    // Kept only as long as they are useful (see the retention table in the README)
    await pool.query('DELETE FROM notifications WHERE is_read = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 180 DAY)');
    await pool.query('DELETE FROM alerts_sent WHERE sent_at < DATE_SUB(NOW(), INTERVAL 90 DAY)');
    await require('./utils/rateLimit').pruneRateLimits();
    // The activity log is evidence, so it is kept for two years and then removed
    await pool.query('DELETE FROM admin_activity_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 730 DAY)');
    await require('./utils/recheck').recheckLivePosts();
    // Images whose event, post or report is gone, and screenshots from closed reports
    await require('./utils/images').removeOrphanImages();
  } catch (err) {
    console.error('Clean-up skipped:', err.message);
  }
}
cleanUpOldRecords();

// Two-factor secrets saved before encryption was added are encrypted once at start-up
async function sealOldTwoFactorSecrets() {
  try {
    const { seal, open, needsReseal } = require('./utils/secretBox');
    // Plain secrets, and secrets sealed with an older key, are sealed with the current key
    const [all] = await pool.query('SELECT user_id, totp_secret FROM users WHERE totp_secret IS NOT NULL');
    const rows = all.filter((r) => needsReseal(r.totp_secret));
    for (const r of rows) {
      await pool.execute('UPDATE users SET totp_secret = :s WHERE user_id = :id AND totp_secret = :old', { s: seal(open(r.totp_secret)), id: r.user_id, old: r.totp_secret });
    }
    if (rows.length) console.log(`Encrypted ${rows.length} two-factor secret${rows.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('Two-factor secret encryption skipped:', err.message);
  }
}
sealOldTwoFactorSecrets();
setInterval(cleanUpOldRecords, 12 * 60 * 60 * 1000).unref();
// Event reminders the day before, checked every hour
const remindEvents = () => require('./utils/eventReminders').sendEventReminders().catch((err) => console.error('Event reminders skipped:', err.message));
remindEvents();
setInterval(remindEvents, 60 * 60 * 1000).unref();
// Remind admins about posts waiting more than 48 hours (never auto-approves)
setInterval(() => require('./controllers/moderation.controller').remindStale(), 12 * 60 * 60 * 1000).unref();

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`AlumNet running at http://localhost:${PORT}`));

// Stop cleanly when asked (the host redeploying, or the tests finishing): finish
// requests in progress, close the database pool, then exit. A clean exit is
// also what lets the coverage tool record which code the tests ran.
function shutDown() {
  server.close(() => pool.end().catch(() => null).finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutDown);
process.on('SIGINT', shutDown);
