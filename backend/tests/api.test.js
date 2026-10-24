/*
 * End-to-end API tests: sign-up verification, sessions, account security,
 * privacy rights, the admin verification queue and HR imports.
 *
 * The tests start the real server against a real MySQL database, so they
 * check actual persistence rather than mocks. They create and change
 * accounts, so they refuse to run unless DB_NAME ends in "_test".
 *
 * Run: npm test   (DB_* variables pointing at an empty test database that
 *                  has every migration in database/migrations applied)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const { authenticator } = require('otplib');
const { PRIVACY_VERSION } = require('../src/utils/privacy');

// Only the database connection comes from backend/.env (anything set in the
// terminal, such as DB_NAME=alumnet_test, wins). Every other setting is fixed
// below, so a laptop's own choices (two-factor off, a running ML service) can
// never change what the tests check.
try {
  const local = require('dotenv').parse(require('node:fs').readFileSync(path.join(__dirname, '..', '.env')));
  for (const [k, v] of Object.entries(local)) if (k.startsWith('DB_') && process.env[k] === undefined) process.env[k] = v;
} catch { /* no .env (as in CI): the DB_* variables come from the environment */ }

const PORT = process.env.TEST_PORT || 4999;
// Read once: later, loading the app's own modules also reads backend/.env,
// which may hold a different secret
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const ROOT = `http://localhost:${PORT}`;

if (!String(process.env.DB_NAME || '').endsWith('_test')) {
  console.error('Refusing to run: DB_NAME must end in "_test" so real data is never touched.');
  process.exit(1);
}

let server;
let serverLog = '';
let db;

/* A tiny browser: keeps cookies per "person" and adds the app header */
function client() {
  const jar = {};
  return {
    jar,
    async call(method, route, body) {
      const res = await fetch(ROOT + '/api' + route, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'AlumNet',
          Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
        },
        body: body ? JSON.stringify(body) : undefined
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(';');
        const [k, v] = pair.split('=');
        if (attrs.some((a) => a.trim().toLowerCase() === 'max-age=0') || v === '') delete jar[k.trim()];
        else jar[k.trim()] = v;
      }
      let json = null;
      try { json = await res.json(); } catch { /* no body */ }
      return { status: res.status, body: json, headers: res.headers, setCookie: res.headers.getSetCookie() };
    }
  };
}

// Emails are printed to the server log in tests: find the latest link sent to an address
function lastLink(email, page) {
  const re = new RegExp(`To: ${email.replace(/[.+]/g, '\\$&')}[\\s\\S]*?${page}\\?token=([a-f0-9]{64})`, 'g');
  const matches = [...serverLog.matchAll(re)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    namedPlaceholders: true,
    // Same clock as the app (Nairobi time), whatever time zone the database server uses
    timezone: '+03:00'
  });
  await db.query("SET time_zone = '+03:00'");
  // The tests create accounts with fixed emails, so they need an empty database
  const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM users');
  if (Number(n)) throw new Error('The test database already has data from an earlier run. Run "npm run migrate -- --fresh" first.');
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      JWT_SECRET,
      APP_URL: ROOT,
      // No email settings, so emails are printed to the log
      SMTP_USER: '', SMTP_PASS: '', BREVO_API_KEY: '', GOOGLE_CLIENT_ID: '', MAIL_DEV_REDIRECT: '', MAIL_FROM: '',
      // The tests check these behaviours, so they are fixed whatever backend/.env says
      ADMIN_2FA_REQUIRED: 'true',
      ML_SERVICE_URL: 'http://127.0.0.1:1', // nothing listens here: the keyword fallback is tested
      ML_API_KEY: '', CORS_ORIGIN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${ROOT}/health`)).ok) return; } catch { /* not up yet */ }
    await wait(200);
  }
  throw new Error(`Server did not start:\n${serverLog}`);
});

after(async () => {
  if (server) server.kill();
  if (db) await db.end();
  // Background jobs are also run directly from these tests through the app's own pool
  if (require.cache[require.resolve('../src/config/db')]) await require('../src/config/db').end();
});

const state = {};
// Synthetic HR records from migration 003 (active) and 011 (former, personal email)
const JOYCE = { staffNumber: 'KQ37954', email: 'joyce.wafula@kenya-airways.com' };
const GEORGE = { staffNumber: 'KQ42857', email: 'george.simiyu@example.com' };

/* ---------------- Sign-up: no information leaks ---------------- */

test('sign-up needs the privacy notice to be accepted', async () => {
  const r = await client().call('POST', '/auth/signup/start', { ...JOYCE });
  assert.equal(r.status, 400);
});

test('sign-up gives the same reply for a real, wrong or unknown staff number', async () => {
  const a = await client().call('POST', '/auth/signup/start', { ...JOYCE, acceptPrivacy: true });
  const b = await client().call('POST', '/auth/signup/start', { staffNumber: 'KQ37954', email: 'thief@example.org', acceptPrivacy: true });
  const c = await client().call('POST', '/auth/signup/start', { staffNumber: 'KQ00000', email: 'nobody@example.org', acceptPrivacy: true });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(b.body, c.body);
  // Nothing about the person is returned
  assert.equal(JSON.stringify(a.body).includes('Joyce'), false);
});

test('the old staff lookup that exposed personal details is gone', async () => {
  const r = await client().call('GET', '/auth/staff-lookup?staffNumber=KQ37954');
  assert.equal(r.status, 404);
});

/* ---------------- Sign-up: automatic verification ---------------- */

test('a link to the HR email lets the real person register, with the role from HR', async () => {
  await wait(200);
  const token = lastLink(JOYCE.email, 'signup.html');
  assert.ok(token, 'signup link should be emailed');
  const me = client();
  const link = await me.call('GET', `/auth/signup/link?token=${token}`);
  assert.equal(link.status, 200);
  assert.equal(link.body.state, 'set_password');
  assert.equal(link.body.name, 'Joyce Wafula');
  assert.equal(link.body.role, 'mentee');

  const weak = await me.call('POST', '/auth/signup/complete', { token, password: 'short' });
  assert.equal(weak.status, 400);
  const done = await me.call('POST', '/auth/signup/complete', { token, password: 'Passw0rd1' });
  assert.equal(done.status, 200);
  assert.equal(done.body.role, 'mentee');
  assert.equal(done.body.onboardingRequired, true);
  state.joyce = me;
});

test('the session cookie is HttpOnly and SameSite', async () => {
  const r = await client().call('POST', '/auth/login', { email: JOYCE.email, password: 'Passw0rd1' });
  assert.equal(r.status, 200);
  const cookie = r.setCookie.find((c) => c.startsWith('alumnet_session='));
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  // The token is never handed to page scripts
  assert.equal(r.body.token, undefined);
});

test('a sign-up link works only once', async () => {
  const token = lastLink(JOYCE.email, 'signup.html');
  const r = await client().call('GET', `/auth/signup/link?token=${token}`);
  assert.equal(r.status, 400);
});

test('registering again with the same email sends a reminder, not a second account', async () => {
  const r = await client().call('POST', '/auth/signup/start', { ...JOYCE, acceptPrivacy: true });
  assert.equal(r.status, 200);
  await wait(200);
  assert.match(serverLog, /You already have an AlumNet account/);
});

test('a retiree registers with the personal email HR holds and becomes a mentor', async () => {
  await client().call('POST', '/auth/signup/start', { ...GEORGE, acceptPrivacy: true });
  await wait(200);
  const token = lastLink(GEORGE.email, 'signup.html');
  const me = client();
  const link = await me.call('GET', `/auth/signup/link?token=${token}`);
  assert.equal(link.body.role, 'mentor');
  const done = await me.call('POST', '/auth/signup/complete', { token, password: 'Passw0rd1' });
  assert.equal(done.body.role, 'mentor');
  state.george = me;
});

/* ---------------- Sign-up: review by the alumni office ---------------- */

test('a non-matching email asks for details instead of revealing anything', async () => {
  await client().call('POST', '/auth/signup/start', { staffNumber: 'KQ29806', email: 'victor.new@example.org', acceptPrivacy: true });
  await wait(200);
  const token = lastLink('victor.new@example.org', 'signup.html');
  const me = client();
  const link = await me.call('GET', `/auth/signup/link?token=${token}`);
  assert.equal(link.body.state, 'details_required');
  assert.equal(link.body.name, undefined);
  const sent = await me.call('POST', '/auth/signup/review', { token, fullName: 'Odhiambo Victor', phone: '0700000000', password: 'Passw0rd1' });
  assert.equal(sent.status, 200);
  // Cannot log in before an admin approves
  const login = await client().call('POST', '/auth/login', { email: 'victor.new@example.org', password: 'Passw0rd1' });
  assert.equal(login.status, 401);
});

test('a stranger using a stolen staff number is flagged high risk', async () => {
  await client().call('POST', '/auth/signup/start', { staffNumber: 'KQ37954', email: 'impostor@example.org', acceptPrivacy: true });
  await wait(200);
  const token = lastLink('impostor@example.org', 'signup.html');
  const me = client();
  await me.call('GET', `/auth/signup/link?token=${token}`);
  const sent = await me.call('POST', '/auth/signup/review', { token, fullName: 'Someone Else', phone: '0711111111', password: 'Passw0rd1' });
  assert.equal(sent.status, 200);
});

/* ---------------- Admin: two-factor required, verification queue ---------------- */

test('admin tools stay locked until the admin turns on two-factor', async () => {
  const hash = await bcrypt.hash('AdminPass1', 10);
  const [r] = await db.execute(
    `INSERT INTO users (name, email, password_hash, status, email_verified_at, onboarded_at, privacy_accepted_at, privacy_version)
     VALUES ('Test Admin', 'admin@example.org', :hash, 'active', NOW(), NOW(), NOW(), :version)`,
    { hash, version: PRIVACY_VERSION }
  );
  await db.execute('INSERT INTO admins (user_id) VALUES (:id)', { id: r.insertId });
  const admin = client();
  const login = await admin.call('POST', '/auth/login', { email: 'admin@example.org', password: 'AdminPass1' });
  assert.equal(login.body.role, 'admin');
  const blocked = await admin.call('GET', '/admin/users');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'two_factor_required');

  const setup = await admin.call('POST', '/auth/2fa/setup');
  state.adminSecret = setup.body.secret;
  const on = await admin.call('POST', '/auth/2fa/enable', { code: authenticator.generate(state.adminSecret) });
  assert.equal(on.status, 200);
  assert.equal(on.body.backupCodes.length, 8);
  const open = await admin.call('GET', '/admin/users');
  assert.equal(open.status, 200);
  state.admin = admin;
});

test('the review queue shows evidence compared with HR, lowest risk first', async () => {
  const r = await state.admin.call('GET', '/admin/signup-requests');
  assert.equal(r.status, 200);
  const victor = r.body.find((x) => x.email === 'victor.new@example.org');
  const impostor = r.body.find((x) => x.email === 'impostor@example.org');
  assert.ok(victor && impostor);
  assert.equal(impostor.risk_level, 'high');
  assert.ok(impostor.signals.some((s) => !s.ok && /already has an account/.test(s.label)));
  assert.ok(victor.signals.some((s) => s.ok && /Name matches/.test(s.label)));
  assert.equal(victor.role_if_approved, 'mentor');
  state.victorId = victor.request_id;
  state.impostorId = impostor.request_id;
});

test('rejecting needs a reason; approving creates the account from the HR record', async () => {
  const noReason = await state.admin.call('PATCH', `/admin/signup-requests/${state.impostorId}/review`, { decision: 'rejected' });
  assert.equal(noReason.status, 400);
  const rejected = await state.admin.call('PATCH', `/admin/signup-requests/${state.impostorId}/review`, { decision: 'rejected', note: 'Staff number already registered' });
  assert.equal(rejected.status, 200);

  const approved = await state.admin.call('PATCH', `/admin/signup-requests/${state.victorId}/review`, { decision: 'approved', note: 'Confirmed by phone' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.role, 'mentor');
  // Name comes from HR, not from what was typed
  const victor = client();
  const login = await victor.call('POST', '/auth/login', { email: 'victor.new@example.org', password: 'Passw0rd1' });
  assert.equal(login.status, 200);
  const me = await victor.call('GET', '/profile/me');
  assert.equal(me.body.name, 'Victor Odhiambo');
});

test('activity log entries name people instead of ID numbers', async () => {
  const r = await state.admin.call('GET', '/admin/activity-logs');
  const text = r.body.items.map((l) => l.description).join(' | ');
  assert.match(text, /Approved sign-up for Victor Odhiambo \(KQ29806\) as mentor/);
  assert.match(text, /Rejected sign-up for Someone Else \(KQ37954\)\. Reason: Staff number already registered/);
});

/* ---------------- CSRF and session control ---------------- */

test('state-changing requests without the app header are refused', async () => {
  const res = await fetch(`${ROOT}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: JOYCE.email, password: 'Passw0rd1' })
  });
  assert.equal(res.status, 403);
});

test('changing the password logs out other devices but keeps this one', async () => {
  const laptop = client();
  const phone = client();
  await laptop.call('POST', '/auth/login', { email: JOYCE.email, password: 'Passw0rd1' });
  await phone.call('POST', '/auth/login', { email: JOYCE.email, password: 'Passw0rd1' });
  const changed = await laptop.call('POST', '/auth/change-password', { currentPassword: 'Passw0rd1', newPassword: 'NewPassw0rd' });
  assert.equal(changed.status, 200);
  assert.equal((await laptop.call('GET', '/auth/account')).status, 200);
  assert.equal((await phone.call('GET', '/auth/account')).status, 401);
  state.joyce = laptop;
});

test('"log out everywhere" ends every session', async () => {
  const other = client();
  await other.call('POST', '/auth/login', { email: JOYCE.email, password: 'NewPassw0rd' });
  const r = await state.joyce.call('POST', '/auth/logout-everywhere');
  assert.equal(r.status, 200);
  assert.equal((await other.call('GET', '/auth/account')).status, 401);
  assert.equal((await state.joyce.call('GET', '/auth/account')).status, 401);
  await state.joyce.call('POST', '/auth/login', { email: JOYCE.email, password: 'NewPassw0rd' });
});

test('suspending a user ends their session at once, with a readable log entry', async () => {
  const [[u]] = await db.execute('SELECT user_id FROM users WHERE email = :e', { e: GEORGE.email });
  const r = await state.admin.call('PATCH', `/admin/users/${u.user_id}/toggle-status`, { reason: 'Test' });
  assert.equal(r.status, 200);
  assert.equal((await state.george.call('GET', '/auth/account')).status, 401);
  const logs = await state.admin.call('GET', '/admin/activity-logs');
  assert.match(logs.body.items[0].description, /Suspended George Simiyu \(mentor, /);
  await state.admin.call('PATCH', `/admin/users/${u.user_id}/toggle-status`);
  await state.george.call('POST', '/auth/login', { email: GEORGE.email, password: 'Passw0rd1' });
});

/* ---------------- Password reset ---------------- */

test('a reset link works once, then the new password works', async () => {
  const unknown = await client().call('POST', '/auth/forgot-password', { email: 'nobody@example.org' });
  const known = await client().call('POST', '/auth/forgot-password', { email: JOYCE.email });
  assert.deepEqual(unknown.body, known.body);
  await wait(200);
  const token = lastLink(JOYCE.email, 'reset-password.html');
  assert.ok(token);
  assert.equal((await client().call('POST', '/auth/reset-password', { token, password: 'Reset2Passw0rd' })).status, 200);
  assert.equal((await client().call('POST', '/auth/reset-password', { token, password: 'Again2Passw0rd' })).status, 400);
  const login = await client().call('POST', '/auth/login', { email: JOYCE.email, password: 'Reset2Passw0rd' });
  assert.equal(login.status, 200);
  state.joyce = client();
  await state.joyce.call('POST', '/auth/login', { email: JOYCE.email, password: 'Reset2Passw0rd' });
});

/* ---------------- Two-factor with backup codes ---------------- */

test('two-factor sign-in accepts an app code or a one-time backup code', async () => {
  const setup = await state.joyce.call('POST', '/auth/2fa/setup');
  // The secret is stored encrypted, so a copy of the database cannot make codes
  const [[stored]] = await db.execute("SELECT u.totp_secret FROM users u WHERE u.email = :e", { e: JOYCE.email });
  assert.match(stored.totp_secret, /^v1:/);
  assert.ok(!stored.totp_secret.includes(setup.body.secret));
  const on = await state.joyce.call('POST', '/auth/2fa/enable', { code: authenticator.generate(setup.body.secret) });
  const backup = on.body.backupCodes[0];

  const step = await client().call('POST', '/auth/login', { email: JOYCE.email, password: 'Reset2Passw0rd' });
  assert.equal(step.body.twoFactorRequired, true);
  assert.equal(step.setCookie.some((c) => c.startsWith('alumnet_session=') && !c.includes('Max-Age=0')), false);

  const wrong = await client().call('POST', '/auth/2fa/verify', { tempToken: step.body.tempToken, code: '123456' });
  assert.equal(wrong.status, 401);
  const byBackup = await client().call('POST', '/auth/2fa/verify', { tempToken: step.body.tempToken, code: backup.toUpperCase() });
  assert.equal(byBackup.status, 200);
  const reuse = await client().call('POST', '/auth/2fa/verify', { tempToken: step.body.tempToken, code: backup });
  assert.equal(reuse.status, 401);
  const byApp = await client().call('POST', '/auth/2fa/verify', { tempToken: step.body.tempToken, code: authenticator.generate(setup.body.secret) });
  assert.equal(byApp.status, 200);
  state.joyceSecret = setup.body.secret;
});

/* ---------------- Profiles, matching gate and privacy ---------------- */

test('matching stays locked until the three matching fields are filled', async () => {
  const locked = await state.joyce.call('GET', '/recommendations');
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'profile_incomplete');
  const saved = await state.joyce.call('PUT', '/profile/me', {
    skills: 'Customer service, safety briefings', experience: 'Three years as cabin crew',
    careerInterests: 'Becoming a cabin crew trainer', completeOnboarding: true
  });
  assert.equal(saved.status, 200);
  const me = await state.joyce.call('GET', '/profile/me');
  assert.ok(me.body.onboarded_at);
  assert.equal(me.body.verified, true);
});

test('a mentee profile is hidden from mentors she has not contacted', async () => {
  const [[j]] = await db.execute('SELECT user_id FROM users WHERE email = :e', { e: JOYCE.email });
  const hidden = await state.george.call('GET', `/profile/${j.user_id}`);
  assert.equal(hidden.status, 404);
  const [[g]] = await db.execute('SELECT user_id FROM users WHERE email = :e', { e: GEORGE.email });
  const mentor = await state.joyce.call('GET', `/profile/${g.user_id}`);
  assert.equal(mentor.status, 200);
  assert.equal(mentor.body.verified_label, 'Verified former KQ staff');
  assert.equal('email' in mentor.body, false);
});

/* ---------------- Trust and safety (Module 2) ---------------- */

// Extra members created straight in the database, for tests that need several people
async function makeMember(name, email, role) {
  const hash = await bcrypt.hash('Passw0rd1', 4);
  const [r] = await db.execute(
    `INSERT INTO users (name, email, password_hash, status, email_verified_at, onboarded_at, privacy_accepted_at, privacy_version)
     VALUES (:name, :email, :hash, 'active', NOW(), NOW(), NOW(), :version)`,
    { name, email, hash, version: PRIVACY_VERSION }
  );
  await db.execute(`INSERT INTO ${role === 'mentor' ? 'mentors' : 'mentees'} (user_id) VALUES (:id)`, { id: r.insertId });
  await db.execute('INSERT INTO profiles (user_id) VALUES (:id)', { id: r.insertId });
  const me = client();
  const login = await me.call('POST', '/auth/login', { email, password: 'Passw0rd1' });
  assert.equal(login.status, 200);
  return { id: r.insertId, me };
}
const nextMonth = () => new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

test('the scam check flags fees, WhatsApp and fake Kenya Airways links, and passes a normal post', () => {
  const { scanPost } = require('../src/utils/scam');
  const bad = scanPost({
    title: 'Cabin crew jobs', company: 'Kenya Airways',
    description: 'Urgently hiring! Pay a registration fee of KSh 2,000 via M-Pesa then WhatsApp 0712 345 678',
    link: 'https://bit.ly/kq-jobs'
  });
  assert.equal(bad.level, 'high');
  const labels = bad.flags.map((f) => f.label).join(' | ');
  assert.match(labels, /pay/i);
  assert.match(labels, /WhatsApp/);
  assert.match(labels, /bit\.ly/);
  const good = scanPost({ title: 'Safety analyst', company: 'Jambojet', description: 'Two years in aviation safety.', link: 'https://careers.jambojet.com/safety' });
  assert.equal(good.level, 'low');
  assert.equal(good.flags.length, 0);
});

test('a mentee introduces herself; contact details appear only after the mentor accepts', async () => {
  const [[g]] = await db.execute('SELECT user_id FROM users WHERE email = :e', { e: GEORGE.email });
  state.georgeId = g.user_id;
  const sent = await state.joyce.call('POST', '/mentorship-requests', { mentorId: g.user_id, message: 'I would like guidance on becoming a cabin crew trainer.' });
  assert.equal(sent.status, 201);

  const seen = await state.george.call('GET', '/mentorship-requests');
  const req = seen.body.find((r) => r.request_id === sent.body.request_id);
  assert.equal(req.message, 'I would like guidance on becoming a cabin crew trainer.');
  assert.equal(req.other_email, null);
  assert.equal(req.other_verified, true);

  const ok = await state.george.call('PATCH', `/mentorship-requests/${sent.body.request_id}`, { decision: 'accepted' });
  assert.equal(ok.status, 200);
  const mine = await state.joyce.call('GET', '/mentorship-requests');
  assert.equal(mine.body.find((r) => r.request_id === sent.body.request_id).other_email, GEORGE.email);
  state.requestId = sent.body.request_id;
});

test('a risky opportunity is flagged for the poster and sorted first for the admin', async () => {
  const scam = await state.george.call('POST', '/opportunities', {
    title: 'Ground staff wanted', company: 'Kenya Airways', opportunityType: 'full_time',
    description: 'Guaranteed job. Pay a processing fee to our M-Pesa till number.',
    applyLink: 'kqjobs@gmail.com', closingDate: nextMonth()
  });
  assert.equal(scam.status, 201);
  // High-risk posters get a general notice, not the list of rules they tripped
  assert.equal(scam.body.needsCloserReview, true);
  assert.equal(scam.body.warnings.length, 0);
  const fine = await state.george.call('POST', '/opportunities', {
    title: 'Safety analyst', company: 'Jambojet', opportunityType: 'full_time',
    description: 'Two years in aviation safety. Apply on the careers page.',
    applyLink: 'https://careers.jambojet.com/safety', closingDate: nextMonth()
  });
  const pending = await state.admin.call('GET', '/admin/opportunities/pending');
  assert.equal(pending.body[0].opportunity_id, scam.body.opportunityId);
  assert.equal(pending.body[0].risk_level, 'high');
  assert.ok(pending.body[0].risk_flags.some((f) => /kenya-airways\.com/.test(f.label)));
  await state.admin.call('PATCH', `/admin/opportunities/${fine.body.opportunityId}/review`, { decision: 'approved' });
  state.fineOppId = fine.body.opportunityId;
});

test('reports: no self-reports, no duplicates, and three reporters hide a post until review', async () => {
  const own = await state.george.call('POST', '/safety/reports', { targetType: 'opportunity', targetId: state.fineOppId, reason: 'spam' });
  assert.equal(own.status, 400);
  const first = await state.joyce.call('POST', '/safety/reports', { targetType: 'opportunity', targetId: state.fineOppId, reason: 'misleading', details: 'This company is not hiring.' });
  assert.equal(first.status, 201);
  const again = await state.joyce.call('POST', '/safety/reports', { targetType: 'opportunity', targetId: state.fineOppId, reason: 'misleading' });
  assert.equal(again.status, 200);
  assert.match(again.body.message, /already reported/);

  const a = await makeMember('Amina Test', 'amina.test@example.org', 'mentee');
  const b = await makeMember('Brian Test', 'brian.test@example.org', 'mentee');
  await a.me.call('POST', '/safety/reports', { targetType: 'opportunity', targetId: state.fineOppId, reason: 'spam' });
  let visible = await a.me.call('GET', '/opportunities');
  assert.ok(visible.body.some((o) => o.opportunity_id === state.fineOppId));
  await b.me.call('POST', '/safety/reports', { targetType: 'opportunity', targetId: state.fineOppId, reason: 'asked_for_money' });
  visible = await a.me.call('GET', '/opportunities');
  assert.equal(visible.body.some((o) => o.opportunity_id === state.fineOppId), false);

  const queue = await state.admin.call('GET', '/admin/reports');
  const group = queue.body.find((g) => g.target_type === 'opportunity' && g.target_id === state.fineOppId);
  assert.equal(group.reporters, 3);
  assert.equal(group.target.title, 'Safety analyst');
});

test('an admin removes a reported post: reporters hear back and the log says what happened', async () => {
  const noNote = await state.admin.call('POST', '/admin/reports/resolve', { targetType: 'opportunity', targetId: state.fineOppId, action: 'remove_content' });
  assert.equal(noNote.status, 400);
  const done = await state.admin.call('POST', '/admin/reports/resolve', { targetType: 'opportunity', targetId: state.fineOppId, action: 'remove_content', note: 'Jambojet confirmed there is no such role' });
  assert.equal(done.status, 200);
  assert.equal(done.body.resolved, 3);
  const [[o]] = await db.execute('SELECT approval_status FROM career_opportunities WHERE opportunity_id = :id', { id: state.fineOppId });
  assert.equal(o.approval_status, 'rejected');
  const notes = await state.joyce.call('GET', '/notifications');
  assert.ok(notes.body.some((n) => /reviewed it/.test(n.message)));
  const logs = await state.admin.call('GET', '/admin/activity-logs');
  assert.match(logs.body.items[0].description, /Removed opportunity "Safety analyst" after 3 reports/);
});

test('blocking ends the mentorship, hides the profile and stops new requests', async () => {
  const [[j]] = await db.execute('SELECT user_id FROM users WHERE email = :e', { e: JOYCE.email });
  const block = await state.george.call('POST', `/safety/blocks/${j.user_id}`);
  assert.equal(block.status, 200);
  const [[r]] = await db.execute('SELECT status FROM mentorship_requests WHERE request_id = :id', { id: state.requestId });
  assert.equal(r.status, 'ended');
  assert.equal((await state.joyce.call('GET', `/profile/${state.georgeId}`)).status, 404);
  const retry = await state.joyce.call('POST', '/mentorship-requests', { mentorId: state.georgeId });
  assert.equal(retry.status, 403);
  const list = await state.george.call('GET', '/safety/blocks');
  assert.equal(list.body[0].name, 'Joyce Wafula');
  await state.george.call('DELETE', `/safety/blocks/${j.user_id}`);
  assert.equal((await state.joyce.call('GET', `/profile/${state.georgeId}`)).status, 200);
});

test('a member reported for asking money can be suspended from the reports queue', async () => {
  const sent = await state.joyce.call('POST', '/safety/reports', { targetType: 'user', targetId: state.georgeId, reason: 'asked_for_money', details: 'Asked me to pay for a CV review.' });
  assert.equal(sent.status, 201);
  const done = await state.admin.call('POST', '/admin/reports/resolve', { targetType: 'user', targetId: state.georgeId, action: 'suspend_user', note: 'Confirmed by phone with the mentee' });
  assert.equal(done.status, 200);
  assert.equal((await state.george.call('GET', '/auth/account')).status, 401);
  const stats = await state.admin.call('GET', '/admin/stats');
  assert.equal(stats.body.openReports, 0);
});


test('the scam check ignores reassurances and job titles, and catches Swahili and disguised words', () => {
  const { scanPost } = require('../src/utils/scam');
  const level = (description) => scanPost({ title: 'Role', company: 'Jambojet', description, link: 'https://www.jambojet.com/careers' }).level;
  assert.equal(level('There is no application fee. We will never ask you to pay.'), 'low');
  assert.equal(level('Deposit Operations Officer handling customer deposits.'), 'low');
  assert.equal(level('Product manager for M-Pesa merchant services.'), 'low');
  assert.equal(level('Lipa ada ya usajili KSh 2000 kisha tutakupigia'), 'high');
  assert.equal(level('Pay a registr4tion f.e.e of 2k via Em-pesa'), 'high');
});

test('a request message asking for money warns the mentor and reaches the reports queue', async () => {
  const carol = await makeMember('Carol Test', 'carol.test@example.org', 'mentee');
  const peter = await makeMember('Peter Mentor', 'peter.mentor@example.org', 'mentor');
  state.carol = carol;
  state.peter = peter;
  const sent = await carol.me.call('POST', '/mentorship-requests', {
    mentorId: peter.id, message: 'Hi, please send the KSh 500 booking fee via M-Pesa till number 123456 and WhatsApp me.'
  });
  assert.equal(sent.status, 201);
  const mentorView = await peter.me.call('GET', '/mentorship-requests');
  assert.ok(mentorView.body[0].message_warnings.length >= 1);
  const menteeView = await carol.me.call('GET', '/mentorship-requests');
  assert.equal(menteeView.body[0].message_warnings.length, 0);
  const queue = await state.admin.call('GET', '/admin/reports');
  const group = queue.body.find((g) => g.target_type === 'user' && g.target_id === carol.id);
  assert.equal(group.automatic, true);
  assert.equal(group.reporters, 0);
  assert.match(group.reports[0].details, /mentorship request message/);
});

test('profile text is checked too, without piling up duplicate reports', async () => {
  await state.peter.me.call('PUT', '/profile/me', { bio: 'Sessions cost KSh 1,000. Pay via M-Pesa before we meet.' });
  await state.peter.me.call('PUT', '/profile/me', { bio: 'Sessions cost KSh 1,000. Pay via M-Pesa before we meet. WhatsApp me.' });
  const [rows] = await db.execute("SELECT COUNT(*) AS n FROM reports WHERE source = 'automatic' AND target_type = 'user' AND target_id = :id AND status = 'open'", { id: state.peter.id });
  assert.equal(rows[0].n, 1);
  for (const id of [state.carol.id, state.peter.id]) {
    const r = await state.admin.call('POST', '/admin/reports/resolve', { targetType: 'user', targetId: id, action: 'dismiss' });
    assert.equal(r.status, 200);
  }
  const stats = await state.admin.call('GET', '/admin/stats');
  assert.equal(stats.body.openReports, 0);
});

/* ---------------- Smart moderation ---------------- */

const clean = (title, link = 'https://www.jambojet.com/careers') => ({
  title, company: 'Jambojet', opportunityType: 'full_time', location: 'Nairobi',
  description: 'Support the safety management system and analyse incident reports. Apply on the careers page.',
  applyLink: link, closingDate: nextMonth()
});
const findItem = (queue, id) => queue.body.items.find((i) => i.kind === 'opportunity' && i.id === id);

test('a new poster always goes to the queue, and the admin sees why', async () => {
  const r = await state.peter.me.call('POST', '/opportunities', clean('Safety Officer'));
  assert.equal(r.status, 201);
  assert.equal(r.body.published, false);
  const queue = await state.admin.call('GET', '/admin/moderation');
  const item = findItem(queue, r.body.opportunityId);
  assert.equal(item.moderation_lane, 'queue');
  assert.ok(item.lane_reasons.some((x) => /not yet trusted/.test(x)));
  assert.equal(item.poster_trust.trusted, false);
  state.peterPost = r.body.opportunityId;
});

test('the admin can ask for changes; the poster edits and it goes back through the checks', async () => {
  const noNote = await state.admin.call('POST', `/admin/moderation/opportunity/${state.peterPost}/decision`, { decision: 'changes_requested' });
  assert.equal(noNote.status, 400);
  const asked = await state.admin.call('POST', `/admin/moderation/opportunity/${state.peterPost}/decision`, { decision: 'changes_requested', note: 'Add the salary range and location' });
  assert.equal(asked.body.state, 'changes_requested');
  const mine = await state.peter.me.call('GET', '/opportunities/mine');
  assert.equal(mine.body.find((p) => p.opportunity_id === state.peterPost).review_note, 'Add the salary range and location');
  const resent = await state.peter.me.call('PUT', `/opportunities/${state.peterPost}`, { ...clean('Safety Officer'), location: 'Nairobi, Embakasi' });
  assert.equal(resent.status, 200);
  const queue = await state.admin.call('GET', '/admin/moderation');
  assert.ok(findItem(queue, state.peterPost).lane_reasons.some((x) => /Resubmitted/.test(x)));
  // Still waiting for review: a further edit is allowed and it stays in the queue
  const twice = await state.peter.me.call('PUT', `/opportunities/${state.peterPost}`, clean('Safety Officer'));
  assert.equal(twice.status, 200);
  const [[still]] = await db.execute('SELECT approval_status FROM career_opportunities WHERE opportunity_id = :id', { id: state.peterPost });
  assert.equal(still.approval_status, 'pending');
});

test('a rejection needs a reason, and the poster is told it', async () => {
  const r = await state.peter.me.call('POST', '/opportunities', clean('Duplicate Analyst'));
  const none = await state.admin.call('POST', `/admin/moderation/opportunity/${r.body.opportunityId}/decision`, { decision: 'rejected' });
  assert.equal(none.status, 400);
  const ok = await state.admin.call('POST', `/admin/moderation/opportunity/${r.body.opportunityId}/decision`, { decision: 'rejected', reason: 'duplicate' });
  assert.equal(ok.status, 200);
  const notes = await state.peter.me.call('GET', '/notifications');
  assert.ok(notes.body.some((n) => /Already posted/.test(n.message)));
});

test('a trusted poster on a known site is published straight away, but only when the fast lane is on', async () => {
  const tess = await makeMember('Tess Trusted', 'tess.trusted@example.org', 'mentor');
  const [[staff]] = await db.execute(
    `SELECT staff_number FROM staff_directory WHERE employment_status = 'former' AND alumni_eligible = 1
     AND staff_number NOT IN (SELECT staff_number FROM users WHERE staff_number IS NOT NULL) LIMIT 1`
  );
  await db.execute('UPDATE users SET staff_number = :s, created_at = DATE_SUB(NOW(), INTERVAL 40 DAY), totp_enabled = 1 WHERE user_id = :id', { s: staff.staff_number, id: tess.id });
  for (const t of ['Earlier post one', 'Earlier post two']) {
    await db.execute(
      `INSERT INTO career_opportunities (posted_by, title, description, company, opportunity_type, apply_link, closing_date, approval_status, created_at)
       VALUES (:id, :t, 'Earlier post', 'Jambojet', 'full_time', 'https://www.jambojet.com/careers', DATE_ADD(CURDATE(), INTERVAL 20 DAY), 'approved', DATE_SUB(NOW(), INTERVAL 10 DAY))`,
      { id: tess.id, t }
    );
  }
  state.tess = tess;

  const off = await tess.me.call('POST', '/opportunities', clean('Ramp Supervisor'));
  assert.equal(off.body.published, false);
  let queue = await state.admin.call('GET', '/admin/moderation');
  assert.deepEqual(findItem(queue, off.body.opportunityId).lane_reasons, ['Fast lane is switched off']);

  const on = await state.admin.call('PUT', '/admin/moderation/settings', { autoApprove: true });
  assert.equal(on.body.autoApprove, true);
  const fast = await tess.me.call('POST', '/opportunities', clean('Cargo Planner'));
  assert.equal(fast.body.published, true);
  const live = await state.carol.me.call('GET', '/opportunities');
  assert.ok(live.body.some((o) => o.opportunity_id === fast.body.opportunityId));
  const logs = await state.admin.call('GET', '/admin/activity-logs');
  assert.equal(logs.body.items[0].admin_name, 'Automatic');
  assert.match(logs.body.items[0].description, /Auto-approved opportunity "Cargo Planner".*Known employer website \(jambojet\.com\)/);
  state.fastPost = fast.body.opportunityId;

  // A website the alumni office has never approved still needs a person
  const newSite = await tess.me.call('POST', '/opportunities', clean('Lounge Manager', 'https://careers.newairline.co.ke/lounge'));
  assert.equal(newSite.body.published, false);
  queue = await state.admin.call('GET', '/admin/moderation');
  assert.ok(findItem(queue, newSite.body.opportunityId).lane_reasons.some((x) => /New website/.test(x)));
});

test('too many posts in a day are held, however trusted the account', async () => {
  // The alumni office sets the limit (default 5); 3 here, as Tess already posted 3 today
  assert.equal((await state.admin.call('PUT', '/admin/moderation/settings', { burstPerDay: 1 })).status, 400);
  assert.equal((await state.admin.call('PUT', '/admin/moderation/settings', { burstPerDay: 3 })).status, 200);
  assert.equal((await state.admin.call('GET', '/admin/moderation')).body.autoApprove, true);
  const burst = await state.tess.me.call('POST', '/opportunities', clean('Fourth Post Today'));
  assert.equal(burst.body.published, false);
  const queue = await state.admin.call('GET', '/admin/moderation');
  const item = findItem(queue, burst.body.opportunityId);
  assert.equal(item.moderation_lane, 'hold');
  assert.ok(item.lane_reasons.some((x) => /post number 4 in the last 24 hours/.test(x)));
  // Spread the earlier posts out so the next tests are not affected
  await db.execute('UPDATE career_opportunities SET submitted_at = DATE_SUB(NOW(), INTERVAL 2 DAY) WHERE posted_by = :id', { id: state.tess.id });
  await state.admin.call('PUT', '/admin/moderation/settings', { burstPerDay: 5 });
});

test('taking down an auto-approved post removes the poster\'s trust', async () => {
  const noReason = await state.admin.call('POST', `/admin/moderation/opportunity/${state.fastPost}/decision`, { decision: 'take_down' });
  assert.equal(noReason.status, 400);
  const down = await state.admin.call('POST', `/admin/moderation/opportunity/${state.fastPost}/decision`, { decision: 'take_down', reason: 'misleading', note: 'Jambojet confirmed no such role' });
  assert.equal(down.status, 200);
  const next = await state.tess.me.call('POST', '/opportunities', clean('Another Clean Post'));
  assert.equal(next.body.published, false);
  const queue = await state.admin.call('GET', '/admin/moderation');
  assert.ok(queue.body.autoApproved.some((a) => a.id === state.fastPost && a.state === 'rejected'));
  assert.equal(findItem(queue, next.body.opportunityId).poster_trust.trusted, false);
});

test('rejecting a post as a scam blocks its website for every account', async () => {
  const scam = await state.peter.me.call('POST', '/opportunities', clean('Remote Data Entry', 'https://kq-jobs-portal.com/apply'));
  await state.admin.call('POST', `/admin/moderation/opportunity/${scam.body.opportunityId}/decision`, { decision: 'rejected', reason: 'asks_for_payment', note: 'Asked applicants for a fee by phone' });
  const learned = await state.admin.call('GET', '/admin/moderation/learned');
  assert.ok(learned.body.blocked.some((b) => b.value === 'kq-jobs-portal.com'));
  assert.ok(learned.body.known.some((k) => k.domain === 'jambojet.com'));

  const again = await state.tess.me.call('POST', '/opportunities', clean('Data Entry Clerk', 'https://kq-jobs-portal.com/apply'));
  assert.equal(again.body.needsCloserReview, true);
  const queue = await state.admin.call('GET', '/admin/moderation');
  const item = findItem(queue, again.body.opportunityId);
  assert.equal(item.moderation_lane, 'hold');
  assert.ok(item.lane_reasons.some((x) => /rejected as a scam \(kq-jobs-portal\.com\)/.test(x)));
  assert.ok(item.lane_reasons.some((x) => /posted by another account/.test(x)));
});

test('a scam on a shortened link blocks that exact link, not the whole shortener', async () => {
  const scam = await state.peter.me.call('POST', '/opportunities', clean('Airport Jobs', 'https://bit.ly/kq-airport-jobs'));
  await state.admin.call('POST', `/admin/moderation/opportunity/${scam.body.opportunityId}/decision`, { decision: 'rejected', reason: 'asks_for_payment' });
  const learned = await state.admin.call('GET', '/admin/moderation/learned');
  assert.ok(learned.body.blocked.some((b) => b.kind === 'link' && b.value === 'bit.ly/kq-airport-jobs'));
  assert.equal(learned.body.blocked.some((b) => b.value === 'bit.ly'), false);
  const again = await state.tess.me.call('POST', '/opportunities', clean('Airport Jobs Again', 'http://bit.ly/kq-airport-jobs/'));
  const queue = await state.admin.call('GET', '/admin/moderation');
  assert.ok(findItem(queue, again.body.opportunityId).lane_reasons.some((x) => /a link from a post rejected as a scam/.test(x)));
});

test('approve all clean posts leaves held and flagged posts for a person', async () => {
  const before = await state.admin.call('GET', '/admin/moderation');
  const cleanCount = before.body.items.filter((i) => i.clean && i.moderation_lane === 'queue').length;
  assert.ok(cleanCount >= 1);
  const r = await state.admin.call('POST', '/admin/moderation/approve-clean');
  assert.equal(r.body.approved, cleanCount);
  const after = await state.admin.call('GET', '/admin/moderation');
  assert.ok(after.body.items.length > 0);
  assert.ok(after.body.items.every((i) => !i.clean || i.moderation_lane !== 'queue'));
});

test('the accuracy panel compares the automatic checks with admin decisions', async () => {
  const r = await state.admin.call('GET', '/admin/moderation/insights');
  assert.equal(r.status, 200);
  assert.ok(r.body.byRisk.low.decided >= 3);
  assert.equal(r.body.autoApproved, 1);
  assert.equal(r.body.autoTakenDown, 1);
  assert.ok(r.body.knownSites >= 5);
  assert.ok(r.body.blocked >= 1);
  await state.admin.call('PUT', '/admin/moderation/settings', { autoApprove: false });
});

/* ---------------- Discovery (Module 3) ---------------- */

test('mentors set availability and an optional gender, with checks on the values', async () => {
  const bad = await state.peter.me.call('PUT', '/profile/me', { maxMentees: 11 });
  assert.equal(bad.status, 400);
  const badGender = await state.peter.me.call('PUT', '/profile/me', { gender: 'robot' });
  assert.equal(badGender.status, 400);
  const ok = await state.peter.me.call('PUT', '/profile/me', {
    headline: 'Retired cargo operations manager', skills: 'Cargo handling, dangerous goods, team leadership',
    experience: 'Ran the JKIA cargo centre for 12 years', yearsOfExperience: 30,
    maxMentees: 2, meetingMode: 'virtual', availabilityNote: 'One call a month, evenings',
    gender: 'male', genderInSearch: false
  });
  assert.equal(ok.status, 200);
  const me = await state.peter.me.call('GET', '/profile/me');
  assert.equal(me.body.max_mentees, 2);
  assert.equal(me.body.meeting_mode, 'virtual');
  assert.equal(me.body.gender, 'male');
  assert.equal(me.body.gender_in_search, false);
  // Gender stays private until the person agrees to use it in search
  const seen = await state.carol.me.call('GET', `/profile/${state.peter.id}`);
  assert.equal(seen.body.gender, null);
  assert.equal(seen.body.slots_left, 2);
});

test('the mentor directory filters by department, experience, meeting mode and consented gender', async () => {
  const w = await makeMember('Wanjiku Mentor', 'wanjiku.mentor@example.org', 'mentor');
  await db.execute("UPDATE users SET department = 'Cargo & Logistics', city = 'Mombasa' WHERE user_id = :id", { id: w.id });
  await w.me.call('PUT', '/profile/me', {
    headline: 'Former head of ground operations', skills: 'Ground operations, ramp safety, leadership',
    experience: 'Led ramp and baggage teams at Moi International Airport', yearsOfExperience: 18,
    gender: 'female', genderInSearch: true, meetingMode: 'in_person'
  });
  state.wanjiku = w;

  const all = await state.carol.me.call('GET', '/mentors');
  assert.equal(all.status, 200);
  assert.ok(all.body.items.some((m) => m.mentor_id === w.id));
  assert.ok(all.body.facets.departments.some((d) => d.value === 'Cargo & Logistics'));
  assert.ok(all.body.facets.locations.some((l) => l.value === 'Mombasa'));

  const women = await state.carol.me.call('GET', '/mentors?gender=female');
  assert.deepEqual(women.body.items.map((m) => m.mentor_id), [w.id]);
  // Peter is male but did not agree to be found by gender
  const men = await state.carol.me.call('GET', '/mentors?gender=male');
  assert.equal(men.body.items.some((m) => m.mentor_id === state.peter.id), false);

  const senior = await state.carol.me.call('GET', '/mentors?minYears=25');
  assert.ok(senior.body.items.every((m) => m.years_of_experience >= 25));
  assert.ok(senior.body.items.some((m) => m.mentor_id === state.peter.id));
  const online = await state.carol.me.call('GET', '/mentors?mode=virtual');
  assert.equal(online.body.items.some((m) => m.mentor_id === w.id), false);
  const dept = await state.carol.me.call('GET', `/mentors?department=${encodeURIComponent('Cargo & Logistics')}`);
  assert.deepEqual(dept.body.items.map((m) => m.mentor_id), [w.id]);
  const nobody = await state.carol.me.call('GET', '/mentors?gender=robot');
  assert.equal(nobody.status, 400);
});

test('search falls back to keywords when the matching service is unavailable', async () => {
  const r = await state.carol.me.call('GET', '/mentors?q=ramp%20safety');
  assert.equal(r.status, 200);
  assert.equal(r.body.searchMode, 'keywords');
  assert.equal(r.body.items[0].mentor_id, state.wanjiku.id);
  const none = await state.carol.me.call('GET', '/mentors?q=submarine%20welding');
  assert.equal(none.body.total, 0);
});

test('a full or paused mentor cannot get new requests, and a mentor cannot accept past their limit', async () => {
  await state.peter.me.call('PUT', '/profile/me', { maxMentees: 1 });
  const a = await makeMember('Mentee One', 'mentee.one@example.org', 'mentee');
  const b = await makeMember('Mentee Two', 'mentee.two@example.org', 'mentee');
  const ra = await a.me.call('POST', '/mentorship-requests', { mentorId: state.peter.id });
  const rb = await b.me.call('POST', '/mentorship-requests', { mentorId: state.peter.id });
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.equal((await state.peter.me.call('PATCH', `/mentorship-requests/${ra.body.request_id}`, { decision: 'accepted' })).status, 200);
  const over = await state.peter.me.call('PATCH', `/mentorship-requests/${rb.body.request_id}`, { decision: 'accepted' });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'at_capacity');

  const c = await makeMember('Mentee Three', 'mentee.three@example.org', 'mentee');
  const full = await c.me.call('POST', '/mentorship-requests', { mentorId: state.peter.id });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /not taking new mentees/);
  // Full mentors drop out of the default list but can still be found on purpose
  const list = await c.me.call('GET', '/mentors');
  assert.equal(list.body.items.some((m) => m.mentor_id === state.peter.id), false);
  const everyone = await c.me.call('GET', '/mentors?available=0');
  const peter = everyone.body.items.find((m) => m.mentor_id === state.peter.id);
  assert.equal(peter.available, false);
  assert.equal(peter.slots_left, 0);

  await state.wanjiku.me.call('PUT', '/profile/me', { acceptingMentees: false });
  const paused = await c.me.call('POST', '/mentorship-requests', { mentorId: state.wanjiku.id });
  assert.equal(paused.status, 409);
  await state.wanjiku.me.call('PUT', '/profile/me', { acceptingMentees: true });
});

test('the directory pages through results 12 at a time', async () => {
  for (let i = 0; i < 12; i++) await makeMember(`Paging Mentor ${String(i).padStart(2, '0')}`, `paging.${i}@example.org`, 'mentor');
  const p1 = await state.carol.me.call('GET', '/mentors?sort=name');
  assert.equal(p1.body.items.length, 12);
  assert.ok(p1.body.pages >= 2);
  const p2 = await state.carol.me.call('GET', `/mentors?sort=name&page=${p1.body.pages}`);
  assert.ok(p2.body.items.length >= 1);
  const names = p1.body.items.map((m) => m.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.equal((await state.peter.me.call('GET', '/mentors')).status, 403);
});

test('two accepts at the same moment cannot take a mentor past their limit', async () => {
  const mentor = await makeMember('Limit Mentor', 'limit.mentor@example.org', 'mentor');
  await mentor.me.call('PUT', '/profile/me', { maxMentees: 1 });
  const x = await makeMember('Race Mentee X', 'race.x@example.org', 'mentee');
  const y = await makeMember('Race Mentee Y', 'race.y@example.org', 'mentee');
  const rx = await x.me.call('POST', '/mentorship-requests', { mentorId: mentor.id });
  const ry = await y.me.call('POST', '/mentorship-requests', { mentorId: mentor.id });
  const [a, b] = await Promise.all([
    mentor.me.call('PATCH', `/mentorship-requests/${rx.body.request_id}`, { decision: 'accepted' }),
    mentor.me.call('PATCH', `/mentorship-requests/${ry.body.request_id}`, { decision: 'accepted' })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const [[{ n }]] = await db.execute("SELECT COUNT(*) AS n FROM mentorship_requests WHERE mentor_id = :id AND status = 'accepted'", { id: mentor.id });
  assert.equal(n, 1);
  // The mentee still waiting is told the mentor is now full
  const waiting = a.status === 409 ? x : y;
  const notes = await waiting.me.call('GET', '/notifications');
  assert.ok(notes.body.some((m) => /as many mentees as they can take/.test(m.message)));
});

test('two requests at the same moment cannot take a mentee past 5 waiting', async () => {
  const m = await makeMember('Busy Mentee', 'busy.mentee@example.org', 'mentee');
  const [mentors] = await db.execute("SELECT u.user_id FROM users u JOIN mentors mt ON mt.user_id = u.user_id WHERE u.name LIKE 'Paging Mentor%' ORDER BY u.user_id LIMIT 6");
  for (const row of mentors.slice(0, 4)) await m.me.call('POST', '/mentorship-requests', { mentorId: row.user_id });
  const results = await Promise.all(mentors.slice(4, 6).map((row) => m.me.call('POST', '/mentorship-requests', { mentorId: row.user_id })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  state.busy = m;
  state.busyFirstMentor = mentors[0].user_id;
});

test('a request with no reply for 14 days expires and the mentee is told', async () => {
  await db.execute(
    "UPDATE mentorship_requests SET requested_at = DATE_SUB(NOW(), INTERVAL 15 DAY) WHERE mentee_id = :m AND mentor_id = :t",
    { m: state.busy.id, t: state.busyFirstMentor }
  );
  const list = await state.busy.me.call('GET', '/mentorship-requests');
  assert.equal(list.body.find((r) => r.other_user_id === state.busyFirstMentor).status, 'expired');
  const notes = await state.busy.me.call('GET', '/notifications');
  assert.ok(notes.body.some((n) => /expired after 14 days/.test(n.message)));
});

test('pausing tells mentees who are waiting, and the availability note is scam-checked', async () => {
  const waiter = await makeMember('Waiting Mentee', 'waiting.mentee@example.org', 'mentee');
  await waiter.me.call('POST', '/mentorship-requests', { mentorId: state.wanjiku.id });
  await state.wanjiku.me.call('PUT', '/profile/me', { acceptingMentees: false, availabilityNote: 'WhatsApp me first, sessions cost KSh 500 via M-Pesa' });
  const notes = await waiter.me.call('GET', '/notifications');
  assert.ok(notes.body.some((n) => /paused new mentorships/.test(n.message)));
  const queue = await state.admin.call('GET', '/admin/reports');
  assert.ok(queue.body.some((g) => g.target_type === 'user' && g.target_id === state.wanjiku.id && g.automatic));
  await state.admin.call('POST', '/admin/reports/resolve', { targetType: 'user', targetId: state.wanjiku.id, action: 'dismiss' });
  await state.wanjiku.me.call('PUT', '/profile/me', { acceptingMentees: true, availabilityNote: 'Weekday evenings' });
});

test('filter counts respect the other filters, and keyword results say which skills matched', async () => {
  const women = await state.carol.me.call('GET', '/mentors?gender=female&available=0');
  // Only departments that have a consenting woman mentor appear
  assert.deepEqual(women.body.facets.departments.map((d) => d.value), ['Cargo & Logistics']);
  assert.ok(women.body.facets.locations.every((l) => l.value !== 'Kenya'));
  const hit = await state.carol.me.call('GET', '/mentors?q=ramp%20safety');
  assert.ok(hit.body.items[0].related_skills.includes('ramp safety'));
});

test('the directory is rate limited per account', async () => {
  const scraper = await makeMember('Fast Clicker', 'fast.clicker@example.org', 'mentee');
  let last;
  for (let i = 0; i < 31; i++) last = await scraper.me.call('GET', '/mentors');
  assert.equal(last.status, 429);
});

/* ---------------- Smart events and opportunities (Module 4) ---------------- */

test('skill matching and fit bands turn similarity into plain words', () => {
  const { skillCoverage, bandFor } = require('../src/utils/fit');
  const c = skillCoverage('Microsoft Excel, dangerous goods, team leadership, SAP', 'Excel, Dangerous goods regulations, leadership of ramp teams');
  assert.deepEqual(c.have, ['Microsoft Excel', 'dangerous goods', 'team leadership']);
  assert.deepEqual(c.missing, ['SAP']);
  assert.equal(bandFor(80).label, 'Strong fit');
  assert.equal(bandFor(65).label, 'Good fit');
  assert.equal(bandFor(30).label, 'Some overlap');
});

const opp = (title, requiredSkills) => ({
  title, company: 'Jambojet', opportunityType: 'full_time', location: 'Nairobi', requiredSkills,
  description: 'Join the operations team at JKIA. Apply on the careers page.',
  applyLink: 'https://www.jambojet.com/careers', closingDate: nextMonth()
});
async function publish(poster, body) {
  const r = await poster.me.call('POST', '/opportunities', body);
  assert.equal(r.status, 201);
  const d = await state.admin.call('POST', `/admin/moderation/opportunity/${r.body.opportunityId}/decision`, { decision: 'approved' });
  assert.equal(d.status, 200);
  await wait(250);
  return r.body.opportunityId;
}

test('opportunities list up to 8 required skills', async () => {
  const tooMany = await state.wanjiku.me.call('POST', '/opportunities', opp('Too many skills', 'a,b,c,d,e,f,g,h,i'));
  assert.equal(tooMany.status, 400);
});

test('a well-matched mentee gets an alert when a post goes live; others and opted-out members do not', async () => {
  const fits = await makeMember('Alert Fit', 'alert.fit@example.org', 'mentee');
  await fits.me.call('PUT', '/profile/me', { skills: 'Excel, dangerous goods, ramp safety', experience: 'Cargo agent', careerInterests: 'Cargo operations' });
  const noFit = await makeMember('Alert NoFit', 'alert.nofit@example.org', 'mentee');
  await noFit.me.call('PUT', '/profile/me', { skills: 'Piano, painting', experience: 'Music teacher', careerInterests: 'Art' });
  const optedOut = await makeMember('Alert Off', 'alert.off@example.org', 'mentee');
  await optedOut.me.call('PUT', '/profile/me', { skills: 'Excel, dangerous goods, ramp safety', experience: 'Cargo agent', careerInterests: 'Cargo' });
  assert.equal((await optedOut.me.call('PUT', '/auth/account/alerts', { opportunities: false })).status, 200);
  assert.equal((await optedOut.me.call('GET', '/auth/account')).body.alerts.opportunities, false);
  state.alertFit = fits;

  const id = await publish(state.wanjiku, opp('Cargo Agent', 'Excel, dangerous goods, customer service'));
  const got = (await fits.me.call('GET', '/notifications')).body.filter((n) => n.type === 'opportunity_alert');
  assert.equal(got.length, 1);
  assert.match(got[0].message, /You have 2 of 3 skills it asks for/);
  assert.equal(got[0].link, `opportunities.html?open=${id}`);
  assert.equal((await noFit.me.call('GET', '/notifications')).body.some((n) => n.type === 'opportunity_alert'), false);
  assert.equal((await optedOut.me.call('GET', '/notifications')).body.some((n) => n.type === 'opportunity_alert'), false);

  // The list shows the checklist and a band, without the matching service
  const list = await fits.me.call('GET', '/opportunities');
  const card = list.body.find((o) => o.opportunity_id === id);
  assert.deepEqual(card.skills_have, ['Excel', 'dangerous goods']);
  assert.deepEqual(card.skills_missing, ['customer service']);
  assert.equal(card.fit.label, 'Good fit');
  assert.ok(card.fit_reasons[0].startsWith('You have 2 of 3'));
});

test('nobody gets more than 3 alerts a week', async () => {
  for (const t of ['Cargo Agent II', 'Cargo Agent III', 'Cargo Agent IV']) {
    await publish(state.wanjiku, opp(t, 'Excel, dangerous goods, ramp safety'));
  }
  const alerts = (await state.alertFit.me.call('GET', '/notifications')).body.filter((n) => n.type === 'opportunity_alert');
  assert.equal(alerts.length, 3);
});

test('events can target departments and topics, and explain why they suit someone', async () => {
  const bad = await state.admin.call('POST', '/admin/events', {
    title: 'Bad audience', eventDate: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16), mode: 'in_person',
    location: 'Pride Centre', audienceDepartments: ['Not A Department']
  });
  assert.equal(bad.status, 400);

  const cargo = await makeMember('Cargo Staffer', 'cargo.staffer@example.org', 'mentee');
  await db.execute("UPDATE users SET department = 'Cargo & Logistics' WHERE user_id = :id", { id: cargo.id });
  await cargo.me.call('PUT', '/profile/me', { skills: 'Cargo handling', experience: 'Two years in cargo', careerInterests: 'Leadership in cargo operations' });
  const other = await makeMember('Other Staffer', 'other.staffer@example.org', 'mentee');

  const made = await state.admin.call('POST', '/admin/events', {
    title: 'Cargo leadership breakfast', eventDate: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16),
    mode: 'in_person', location: 'Pride Centre, Embakasi', description: 'Breakfast with former cargo leaders.',
    topics: 'Leadership, Cargo operations', audienceDepartments: ['Cargo & Logistics']
  });
  assert.equal(made.status, 201);
  await wait(250);
  const alert = (await cargo.me.call('GET', '/notifications')).body.find((n) => n.type === 'event_alert');
  assert.ok(alert);
  assert.match(alert.message, /leadership/i);
  assert.equal((await other.me.call('GET', '/notifications')).body.some((n) => n.type === 'event_alert'), false);

  const mine = (await cargo.me.call('GET', '/events')).body.find((e) => e.event_id === made.body.eventId);
  assert.equal(mine.for_me, true);
  assert.ok(mine.fit_reasons.includes('For Cargo & Logistics staff'));
  const theirs = (await other.me.call('GET', '/events')).body.find((e) => e.event_id === made.body.eventId);
  assert.equal(theirs.for_me, false);
  state.cargoEventCapacityTest = { cargo, other };
});

test('two people cannot take the last seat at the same moment', async () => {
  const made = await state.admin.call('POST', '/admin/events', {
    title: 'One seat only', eventDate: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 16),
    mode: 'in_person', location: 'Pride Centre', capacity: 1
  });
  const { cargo, other } = state.cargoEventCapacityTest;
  const results = await Promise.all([cargo, other].map((m) => m.me.call('POST', `/events/${made.body.eventId}/register`)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const [[{ n }]] = await db.execute('SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = :id', { id: made.body.eventId });
  assert.equal(n, 1);
});

/* ---------------- Editing live posts and events ---------------- */

const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 16);
async function liveCommunityEvent(organiser, body) {
  const made = await organiser.me.call('POST', '/events', body);
  assert.equal(made.status, 201);
  const d = await state.admin.call('POST', `/admin/moderation/event/${made.body.eventId}/decision`, { decision: 'approved' });
  assert.equal(d.status, 200);
  return made.body.eventId;
}

test('an organiser sees no fit label on their own event, and can edit the venue; registered people are told', async () => {
  const host = await makeMember('Host Mentor', 'host.mentor@example.org', 'mentor');
  const guest = await makeMember('Guest Mentee', 'guest.mentee@example.org', 'mentee');
  const base = { title: 'Ramp safety talk', eventDate: inDays(12), mode: 'in_person', location: 'Pride Centre, Embakasi', capacity: 20, description: 'Safety on the ramp.', topics: 'Safety' };
  const id = await liveCommunityEvent(host, base);
  const own = (await host.me.call('GET', '/events')).body.find((e) => e.event_id === id);
  assert.equal(own.is_mine, true);
  assert.equal(own.fit, null);

  assert.equal((await guest.me.call('POST', `/events/${id}/register`)).status, 201);
  const edit = await host.me.call('PUT', `/events/${id}`, { ...base, location: 'KQ Training Centre, Embakasi' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.published, true);
  const live = (await guest.me.call('GET', '/events')).body.find((e) => e.event_id === id);
  assert.equal(live.location, 'KQ Training Centre, Embakasi');
  assert.ok(live.edited_at);
  const note = (await guest.me.call('GET', '/notifications')).body.find((n) => n.type === 'event_changed');
  assert.match(note.message, /venue/);

  // Capacity cannot drop below the people already registered
  await db.execute('INSERT INTO event_registrations (event_id, user_id) VALUES (:id, :u)', { id, u: host.id });
  const tooSmall = await host.me.call('PUT', `/events/${id}`, { ...base, capacity: 1 });
  assert.equal(tooSmall.status, 400);
  state.liveEdit = { host, guest, id, base };
});

test('changing a live event to a meeting link on an unknown site sends it back for review first', async () => {
  const { host, guest, id, base } = state.liveEdit;
  const edit = await host.me.call('PUT', `/events/${id}`, { ...base, mode: 'virtual', location: 'https://meet.unknown-site.example/abc' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.published, false);
  const [[row]] = await db.execute('SELECT status, lane_reasons FROM events WHERE event_id = :id', { id });
  assert.equal(row.status, 'pending');
  assert.match(row.lane_reasons, /Edited after it was live/);
  assert.equal((await guest.me.call('GET', '/events')).body.some((e) => e.event_id === id), false);
  const held = (await guest.me.call('GET', '/notifications')).body.filter((n) => n.type === 'event_changed');
  assert.ok(held.some((n) => /Your place is kept/.test(n.message)));

  // Once approved, registered people hear what changed
  await state.admin.call('POST', `/admin/moderation/event/${id}/decision`, { decision: 'approved' });
  const after = (await guest.me.call('GET', '/notifications')).body.filter((n) => n.type === 'event_changed');
  assert.ok(after.some((n) => /format/.test(n.message) && /meeting link/.test(n.message)));
});

test('an organiser can cancel their event and registered people are told', async () => {
  const { host, guest, id } = state.liveEdit;
  const r = await host.me.call('POST', `/events/${id}/cancel`, { reason: 'Speaker unwell' });
  assert.equal(r.status, 200);
  assert.equal((await guest.me.call('GET', '/events')).body.some((e) => e.event_id === id), false);
  const note = (await guest.me.call('GET', '/notifications')).body.find((n) => n.type === 'event_cancelled');
  assert.match(note.message, /Speaker unwell/);
  // ...and by email, not only in the app
  await wait(200);
  assert.match(serverLog, /To: guest\.mentee@example\.org\s+Subject: Cancelled: Ramp safety talk/);
  // An admin "delete" keeps the record as cancelled instead of erasing it
  const official = await state.admin.call('POST', '/admin/events', { title: 'Delete me', eventDate: inDays(15), mode: 'in_person', location: 'Pride Centre' });
  assert.equal((await state.admin.call('DELETE', `/admin/events/${official.body.eventId}`)).status, 200);
  const [[kept]] = await db.execute('SELECT status FROM events WHERE event_id = :id', { id: official.body.eventId });
  assert.equal(kept.status, 'cancelled');
  const other = await makeMember('Not The Host', 'not.host@example.org', 'mentor');
  assert.equal((await other.me.call('POST', `/events/${id}/cancel`)).status, 404);
});

test('a live opportunity stays live after a clean edit, goes back for review after a risky one, and can be closed', async () => {
  const poster = await makeMember('Edit Poster', 'edit.poster@example.org', 'mentor');
  const body = opp('Ramp supervisor', 'Ramp safety, Team leadership');
  const id = await publish(poster, body);

  const clean = await poster.me.call('PUT', `/opportunities/${id}`, { ...body, description: body.description + ' Closing date extended.' });
  assert.equal(clean.status, 200);
  assert.equal(clean.body.published, true);

  const risky = await poster.me.call('PUT', `/opportunities/${id}`, { ...body, description: 'Pay a registration fee of KSh 2,000 via M-Pesa to be considered.' });
  assert.equal(risky.status, 200);
  assert.equal(risky.body.published, false);
  const [[row]] = await db.execute('SELECT approval_status FROM career_opportunities WHERE opportunity_id = :id', { id });
  assert.equal(row.approval_status, 'pending');

  await state.admin.call('POST', `/admin/moderation/opportunity/${id}/decision`, { decision: 'approved' });
  assert.equal((await poster.me.call('POST', `/opportunities/${id}/close`)).status, 200);
  const list = (await state.admin.call('GET', '/opportunities')).body;
  assert.equal(list.some((o) => o.opportunity_id === id), false);
  assert.equal((await poster.me.call('PUT', `/opportunities/${id}`, body)).status, 409);
});

test('a full event has a waiting list; the first person in line gets a freed place and is told', async () => {
  const made = await state.admin.call('POST', '/admin/events', { title: 'Tiny workshop', eventDate: inDays(20), mode: 'in_person', location: 'Pride Centre', capacity: 1 });
  const id = made.body.eventId;
  const a = await makeMember('Seat Holder', 'seat.holder@example.org', 'mentee');
  const b = await makeMember('First Waiter', 'first.waiter@example.org', 'mentee');
  const c = await makeMember('Second Waiter', 'second.waiter@example.org', 'mentee');
  assert.equal((await b.me.call('POST', `/events/${id}/waitlist`)).status, 409); // a place is still free
  assert.equal((await a.me.call('POST', `/events/${id}/register`)).status, 201);
  assert.equal((await b.me.call('POST', `/events/${id}/waitlist`)).body.position, 1);
  await wait(5);
  assert.equal((await c.me.call('POST', `/events/${id}/waitlist`)).body.position, 2);
  const seen = (await c.me.call('GET', '/events')).body.find((e) => e.event_id === id);
  assert.equal(seen.waitlist_position, 2);

  assert.equal((await a.me.call('DELETE', `/events/${id}/register`)).status, 200);
  const bView = (await b.me.call('GET', '/events')).body.find((e) => e.event_id === id);
  assert.equal(bView.is_registered, true);
  assert.ok((await b.me.call('GET', '/notifications')).body.some((n) => n.type === 'event_waitlist_place'));
  const cView = (await c.me.call('GET', '/events')).body.find((e) => e.event_id === id);
  assert.equal(cView.is_registered, false);
  assert.equal(cView.waitlist_position, 1);

  // More room: the admin raises the capacity and the next person gets in
  await state.admin.call('PUT', `/admin/events/${id}`, { title: 'Tiny workshop', eventDate: inDays(20), mode: 'in_person', location: 'Pride Centre', capacity: 2 });
  assert.equal((await c.me.call('GET', '/events')).body.find((e) => e.event_id === id).is_registered, true);
});

test('when a scam is rejected, other live posts using the same website are taken down for review', async () => {
  const one = await makeMember('Live Poster', 'live.poster@example.org', 'mentor');
  const two = await makeMember('Scam Poster', 'scam.poster@example.org', 'mentor');
  const liveId = await publish(one, { ...opp('Ramp lead', 'Ramp safety'), applyLink: 'https://jobs.shady-recruiters.example/ramp' });
  const scam = await two.me.call('POST', '/opportunities', { ...opp('Cabin crew', 'Customer care'), applyLink: 'https://jobs.shady-recruiters.example/apply' });
  const r = await state.admin.call('POST', `/admin/moderation/opportunity/${scam.body.opportunityId}/decision`, { decision: 'rejected', reason: 'asks_for_payment' });
  assert.equal(r.status, 200);
  await wait(400);
  const [[row]] = await db.execute('SELECT approval_status, moderation_lane, lane_reasons FROM career_opportunities WHERE opportunity_id = :id', { id: liveId });
  assert.equal(row.approval_status, 'pending');
  assert.equal(row.moderation_lane, 'hold');
  assert.match(row.lane_reasons, /blocked as a scam/);
  const note = (await one.me.call('GET', '/notifications')).body.find((n) => /being checked again/.test(n.message));
  assert.ok(note);
  assert.doesNotMatch(note.message, /shady/);
});

test('registered people get one reminder the day before, in the app and by email', async () => {
  const made = await state.admin.call('POST', '/admin/events', { title: 'Reminder breakfast', eventDate: inDays(3), mode: 'in_person', location: 'Pride Centre' });
  const id = made.body.eventId;
  const m = await makeMember('Reminded Member', 'reminded.member@example.org', 'mentee');
  await m.me.call('POST', `/events/${id}/register`);
  await db.execute('UPDATE events SET event_date = DATE_ADD(NOW(), INTERVAL 20 HOUR) WHERE event_id = :id', { id });
  const { sendEventReminders } = require('../src/utils/eventReminders');
  await sendEventReminders();
  await sendEventReminders(); // a second run sends nothing more
  const notes = (await m.me.call('GET', '/notifications')).body.filter((n) => n.type === 'event_reminder');
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /Reminder breakfast/);
});

test('in the last day before an event, a freed place is offered to everyone waiting instead of given out', async () => {
  const made = await state.admin.call('POST', '/admin/events', { title: 'Last minute seat', eventDate: inDays(3), mode: 'in_person', location: 'Pride Centre', capacity: 1 });
  const id = made.body.eventId;
  const holder = await makeMember('Late Holder', 'late.holder@example.org', 'mentee');
  const waiter = await makeMember('Late Waiter', 'late.waiter@example.org', 'mentee');
  await holder.me.call('POST', `/events/${id}/register`);
  await waiter.me.call('POST', `/events/${id}/waitlist`);
  await db.execute('UPDATE events SET event_date = DATE_ADD(NOW(), INTERVAL 5 HOUR) WHERE event_id = :id', { id });
  await holder.me.call('DELETE', `/events/${id}/register`);
  const view = (await waiter.me.call('GET', '/events')).body.find((e) => e.event_id === id);
  assert.equal(view.is_registered, false);
  assert.ok((await waiter.me.call('GET', '/notifications')).body.some((n) => n.type === 'event_place_free'));
  await wait(200);
  assert.match(serverLog, /To: late\.waiter@example\.org\s+Subject: A place is free: Last minute seat/);
  assert.equal(view.waitlist_position, 1);
  assert.equal((await waiter.me.call('POST', `/events/${id}/register`)).status, 201);
});

test('mentees can save mentors to a shortlist', async () => {
  const mentee = await makeMember('Shortlister', 'shortlister@example.org', 'mentee');
  const mentor = await makeMember('Shortlisted Mentor', 'shortlisted.mentor@example.org', 'mentor');
  assert.equal((await mentee.me.call('POST', `/mentors/${mentor.id}/save`)).status, 201);
  const saved = await mentee.me.call('GET', '/mentors/saved');
  assert.deepEqual(saved.body.map((c) => c.mentor_id), [mentor.id]);
  assert.equal(saved.body[0].saved, true);
  assert.equal((await mentee.me.call('POST', '/mentors/999999/save')).status, 404);
  assert.equal((await mentor.me.call('POST', `/mentors/${mentor.id}/save`)).status, 403);
  await mentee.me.call('DELETE', `/mentors/${mentor.id}/save`);
  assert.equal((await mentee.me.call('GET', '/mentors/saved')).body.length, 0);
});

/* ---------------- Mentorship outcomes (Module 5) ---------------- */

async function activeMentorship(tag) {
  const mentee = await makeMember(`Goal Mentee ${tag}`, `goal.mentee.${tag}@example.org`, 'mentee');
  const mentor = await makeMember(`Goal Mentor ${tag}`, `goal.mentor.${tag}@example.org`, 'mentor');
  const sent = await mentee.me.call('POST', '/mentorship-requests', { mentorId: mentor.id, message: 'I would like help planning a move into cargo operations.' });
  assert.equal(sent.status, 201);
  const [[r]] = await db.execute('SELECT request_id FROM mentorship_requests WHERE mentee_id = :id', { id: mentee.id });
  assert.equal((await mentor.me.call('PATCH', `/mentorship-requests/${r.request_id}`, { decision: 'accepted' })).status, 200);
  return { mentee, mentor, id: r.request_id };
}

test('a mentorship has shared goals and a meeting log that only the two people can see', async () => {
  const { mentee, mentor, id } = await activeMentorship('a');
  const outsider = await makeMember('Outsider', 'outsider@example.org', 'mentee');
  assert.equal((await outsider.me.call('GET', `/mentorship-requests/${id}/workspace`)).status, 404);

  const g = await mentee.me.call('POST', `/mentorship-requests/${id}/goals`, { text: 'Understand how load planning works' });
  assert.equal(g.status, 201);
  assert.ok((await mentor.me.call('GET', '/notifications')).body.some((n) => n.type === 'mentorship_goal'));
  assert.equal((await mentor.me.call('PATCH', `/mentorship-requests/${id}/goals/${g.body.goal_id}`, { done: true })).status, 200);
  // Only the person who added a goal can remove it
  assert.equal((await mentor.me.call('DELETE', `/mentorship-requests/${id}/goals/${g.body.goal_id}`)).status, 404);

  const nairobi = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Africa/Nairobi' });
  const today = nairobi(Date.now());
  const future = nairobi(Date.now() + 3 * 864e5);
  assert.equal((await mentor.me.call('POST', `/mentorship-requests/${id}/meetings`, { metOn: future, mode: 'virtual', minutes: 45 })).status, 400);
  assert.equal((await mentor.me.call('POST', `/mentorship-requests/${id}/meetings`, { metOn: today, mode: 'virtual', minutes: 2 })).status, 400);
  assert.equal((await mentor.me.call('POST', `/mentorship-requests/${id}/meetings`, { metOn: today, mode: 'virtual', minutes: 45, note: 'Went through a load sheet together.' })).status, 201);

  const ws = (await mentee.me.call('GET', `/mentorship-requests/${id}/workspace`)).body;
  assert.equal(ws.goals.length, 1);
  assert.equal(ws.goals[0].done, true);
  assert.equal(ws.meetings.length, 1);
  assert.equal(ws.meetings[0].minutes, 45);
  const card = (await mentee.me.call('GET', '/mentorship-requests')).body.find((r) => r.request_id === id);
  assert.equal(card.goals_done, 1);
  assert.equal(card.meetings, 1);
  state.outcome = { mentee, mentor, id };
});

test('after a mentorship ends, each person rates it once and privately; feeling unsafe opens a report', async () => {
  const { mentee, mentor, id } = state.outcome;
  assert.equal((await mentee.me.call('POST', `/mentorship-requests/${id}/feedback`, { met: true, helpful: 5 })).status, 409); // still active
  assert.equal((await mentee.me.call('POST', `/mentorship-requests/${id}/end`)).status, 200);
  assert.ok((await mentor.me.call('GET', '/notifications')).body.some((n) => /how it went/.test(n.message)));
  // Nothing can be added once it has ended
  assert.equal((await mentee.me.call('POST', `/mentorship-requests/${id}/goals`, { text: 'Too late' })).status, 409);

  assert.equal((await mentee.me.call('POST', `/mentorship-requests/${id}/feedback`, { met: true, helpful: 9 })).status, 400);
  const ok = await mentee.me.call('POST', `/mentorship-requests/${id}/feedback`, { met: true, helpful: 4, goalsProgress: 'most', comment: 'Very practical.' });
  assert.equal(ok.status, 201);
  assert.equal((await mentee.me.call('POST', `/mentorship-requests/${id}/feedback`, { met: true, helpful: 4 })).status, 409);

  const unsafe = await mentor.me.call('POST', `/mentorship-requests/${id}/feedback`, { met: false, feltSafe: false, comment: 'Kept asking for my personal number.' });
  assert.equal(unsafe.status, 201);
  const [[report]] = await db.execute("SELECT reason FROM reports WHERE target_type = 'user' AND target_id = :id AND reporter_id = :by", { id: mentee.id, by: mentor.id });
  assert.equal(report.reason, 'harassment');
  // The other person's answers are never returned to them
  const ws = (await mentee.me.call('GET', `/mentorship-requests/${id}/workspace`)).body;
  assert.equal(ws.feedback_given, true);
  assert.equal(JSON.stringify(ws).includes('personal number'), false);
});

test('the admin can open one member and see their mentorships, ratings, posts and reports, and the view is logged', async () => {
  const { mentee, mentor, id } = state.outcome;
  const r = await state.admin.call('GET', `/admin/users/${mentor.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.account.role, 'mentor');
  const m = r.body.mentorships.find((x) => x.request_id === id);
  assert.equal(m.goals_done, 1);
  assert.equal(m.mentee_rating, 4);
  assert.equal(m.felt_safe, false);
  // One answer is not enough for an average
  assert.equal(r.body.mentor_stats.avg_helpful, null);
  assert.equal(r.body.mentor_stats.feedback_answers, 1);
  const about = (await state.admin.call('GET', `/admin/users/${mentee.id}`)).body;
  assert.ok(about.reports_about.some((x) => x.reason === 'harassment'));
  const [[log]] = await db.execute("SELECT description FROM admin_activity_logs WHERE action_type = 'view_user' AND target_entity_id = :id ORDER BY log_id DESC LIMIT 1", { id: mentee.id });
  assert.match(log.description, /Viewed the details/);
  assert.equal((await mentee.me.call('GET', `/admin/users/${mentor.id}`)).status, 403);
  assert.equal((await state.admin.call('GET', '/admin/users/999999')).status, 404);
});

test('the impact figures add up from the data, and fairness is measured', async () => {
  const { gini, median } = require('../src/controllers/impact.controller');
  assert.equal(gini([5, 5, 5, 5]), 0);
  assert.ok(gini([0, 0, 0, 20]) >= 0.7);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);

  const r = await state.admin.call('GET', '/admin/impact?period=all');
  assert.equal(r.status, 200);
  const [[{ sent }]] = await db.execute('SELECT COUNT(*) AS sent FROM mentorship_requests');
  assert.equal(r.body.mentorship.requests_sent, Number(sent));
  assert.ok(r.body.outcomes.answers >= 2);
  assert.ok(r.body.outcomes.felt_unsafe >= 1);
  assert.equal(r.body.monthly.length, 12);
  assert.equal(r.body.outcomes.rating_counts.length, 5);
  assert.equal((await state.admin.call('GET', '/admin/impact?period=7')).status, 400);
  assert.equal((await state.outcome.mentee.me.call('GET', '/admin/impact')).status, 403);
});

test('the activity log can be filtered, paged and exported, and record views are hidden unless asked for', async () => {
  const all = (await state.admin.call('GET', '/admin/activity-logs')).body;
  assert.ok(all.total > 0 && all.items.length <= 50);
  assert.equal(all.items.some((l) => l.action_type === 'view_user'), false);
  const views = (await state.admin.call('GET', '/admin/activity-logs?action=view_user')).body;
  assert.ok(views.items.length >= 1 && views.items.every((l) => l.action_type === 'view_user'));
  const auto = (await state.admin.call('GET', '/admin/activity-logs?by=automatic')).body;
  assert.ok(auto.items.every((l) => l.admin_name === 'Automatic'));
  const words = (await state.admin.call('GET', '/admin/activity-logs?q=Victor')).body;
  assert.ok(words.items.length >= 1 && words.items.every((l) => /Victor/.test(l.description + l.target_label)));
  const future = (await state.admin.call('GET', '/admin/activity-logs?from=2999-01-01')).body;
  assert.equal(future.total, 0);
  const res = await fetch(`http://localhost:${process.env.TEST_PORT || 4999}/api/admin/activity-logs?format=csv&q=Victor`, {
    headers: { 'X-Requested-With': 'AlumNet', Cookie: Object.entries(state.admin.jar).map(([k, v]) => `${k}=${v}`).join('; ') }
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv.split('\r\n')[0], /^time,by,action/);
  assert.match(csv, /Victor/);
});

/* ---------------- Batch A hardening ---------------- */

test('admin sessions end after 30 idle minutes and 12 hours; member sessions last longer', async () => {
  const jwt = require('jsonwebtoken');
  const secret = JWT_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const [[adminRow]] = await db.execute("SELECT user_id, session_version FROM users WHERE email = 'admin@example.org'");
  const call = (token) => fetch(`${ROOT}/api/auth/account`, { headers: { Cookie: `alumnet_session=${token}` } });
  const token = (claims) => jwt.sign({ userId: adminRow.user_id, role: 'admin', sv: adminRow.session_version, ...claims }, secret);
  // Idle for 31 minutes: the token has expired
  assert.equal((await call(token({ at: now - 3600, act: now - 31 * 60, exp: now - 60 }))).status, 401);
  // Active, but signed in 13 hours ago
  assert.equal((await call(token({ at: now - 13 * 3600, act: now - 60, exp: now + 600 }))).status, 401);
  // Active and recent: allowed, and the cookie is renewed when it is over 5 minutes old
  const ok = await call(token({ at: now - 3600, act: now - 10 * 60, exp: now + 20 * 60 }));
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith('alumnet_session=') && /Max-Age=(1[0-9]{3}|[0-9]{1,3})\b/.test(c)));
  // A member idle for a day is still signed in
  const m = await makeMember('Idle Member', 'idle.member@example.org', 'mentee');
  const [[mr]] = await db.execute('SELECT session_version FROM users WHERE user_id = :id', { id: m.id });
  const memberToken = jwt.sign({ userId: m.id, role: 'mentee', sv: mr.session_version, at: now - 86400, act: now - 86400, exp: now + 86400 }, secret);
  assert.equal((await call(memberToken)).status, 200);
});

test('wrong passwords from many addresses still lock one account, and the owner is told once', async () => {
  const victim = await makeMember('Targeted Member', 'targeted.member@example.org', 'mentee');
  let last;
  for (let i = 0; i < 22; i++) {
    last = await fetch(`${ROOT}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AlumNet', 'X-Forwarded-For': `10.9.${i}.1` },
      body: JSON.stringify({ email: 'targeted.member@example.org', password: `wrong-${i}` })
    });
  }
  assert.equal(last.status, 429);
  const notes = (await victim.me.call('GET', '/notifications')).body.filter((n) => /wrong password attempts/.test(n.message));
  assert.equal(notes.length, 1);
});

test('each member has an hourly limit on changes, and meetings per day are capped', async () => {
  const { mentee, id } = await activeMentorship('cap');
  const nairobi = new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Nairobi' });
  for (let i = 0; i < 3; i++) {
    assert.equal((await mentee.me.call('POST', `/mentorship-requests/${id}/meetings`, { metOn: nairobi, mode: 'phone', minutes: 15 })).status, 201);
  }
  assert.equal((await mentee.me.call('POST', `/mentorship-requests/${id}/meetings`, { metOn: nairobi, mode: 'phone', minutes: 15 })).status, 409);

  const busy = await makeMember('Busy Clicker', 'busy.clicker@example.org', 'mentee');
  let status = 0;
  for (let i = 0; i < 121 && status !== 429; i++) status = (await busy.me.call('DELETE', '/mentors/1/save')).status;
  assert.equal(status, 429);
  // Reading is not limited
  assert.equal((await busy.me.call('GET', '/events')).status, 200);
});

test('download my data includes the shortlist, waiting lists, reports, blocks and alerts', async () => {
  const r = await state.outcome.mentee.me.call('GET', '/auth/account/export');
  for (const key of ['saved_mentors', 'event_waiting_lists', 'events_proposed', 'reports_you_made', 'people_you_blocked', 'alerts_sent_to_you', 'mentorship_goals', 'mentorship_feedback_you_gave']) {
    assert.ok(key in r.body, key);
  }
  assert.ok('alert_events' in r.body.account);
});

test('the department comes from HR at sign-in, even if the account says otherwise', async () => {
  // Like Mark Thuo's account, linked to his HR record by hand with an old department
  const m = await makeMember('Hand Linked', 'hand.linked@example.org', 'mentee');
  await db.execute("UPDATE users SET staff_number = 'KQ30957', department = 'Flight Operations' WHERE user_id = :id", { id: m.id });
  const again = client();
  assert.equal((await again.call('POST', '/auth/login', { email: 'hand.linked@example.org', password: 'Passw0rd1' })).status, 200);
  const [[after]] = await db.execute('SELECT department FROM users WHERE user_id = :id', { id: m.id });
  assert.equal(after.department, 'Cabin Services');
});

/* ---------------- HR import and retirement ---------------- */

test('an HR import previews changes, then a retired mentee becomes a mentor', async () => {
  const rows = [
    { staff_number: 'KQ37954', full_name: 'Joyce Wafula', department: 'Cabin Services', kq_email: JOYCE.email,
      personal_email: 'joyce.personal@example.org', employment_status: 'former', alumni_eligible: '1' },
    { staff_number: 'KQ99999', full_name: 'New Starter', department: 'Cargo', kq_email: 'new.starter@kenya-airways.com', employment_status: 'active' },
    { staff_number: 'bad row', full_name: '', employment_status: 'retired' }
  ];
  const preview = await state.admin.call('POST', '/admin/hr/preview', { rows });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.added.length, 1);
  assert.equal(preview.body.retiring.length, 1);
  assert.equal(preview.body.invalid.length, 1);

  const applied = await state.admin.call('POST', '/admin/hr/apply', { rows });
  assert.equal(applied.status, 200);
  // Her old session ends; on the next login she is a mentor
  assert.equal((await state.joyce.call('GET', '/auth/account')).status, 401);
  const step = await client().call('POST', '/auth/login', { email: JOYCE.email, password: 'Reset2Passw0rd' });
  const again = client();
  const done = await again.call('POST', '/auth/2fa/verify', { tempToken: step.body.tempToken, code: authenticator.generate(state.joyceSecret) });
  assert.equal(done.body.role, 'mentor');
  state.joyce = again;
});

test('someone HR marks as not eligible cannot sign in', async () => {
  await state.admin.call('POST', '/admin/hr/apply', { rows: [
    { staff_number: 'KQ42857', full_name: 'George Simiyu', department: 'Flight Operations', personal_email: GEORGE.email, employment_status: 'former', alumni_eligible: '0' }
  ] });
  const r = await client().call('POST', '/auth/login', { email: GEORGE.email, password: 'Passw0rd1' });
  assert.equal(r.status, 403);
});

test('with two admins, an HR import waits for the other admin, who cannot be the uploader', async () => {
  // A second admin account (it only needs to exist for the rule to apply)
  const second = await makeMember('Second Admin', 'second.admin@example.org', 'mentee');
  await db.execute('INSERT INTO admins (user_id) VALUES (:id)', { id: second.id });
  const rows = [{ staff_number: 'KQ88888', full_name: 'Four Eyes', department: 'Finance', kq_email: 'four.eyes@kenya-airways.com', employment_status: 'active' }];

  const asked = await state.admin.call('POST', '/admin/hr/apply', { rows });
  assert.equal(asked.status, 202);
  assert.equal(asked.body.waitingForSecondAdmin, true);
  const [[none]] = await db.execute("SELECT COUNT(*) AS n FROM staff_directory WHERE staff_number = 'KQ88888'");
  assert.equal(Number(none.n), 0);
  const own = await state.admin.call('POST', `/admin/hr/requests/${asked.body.requestId}/decision`, { decision: 'approve' });
  assert.equal(own.status, 403);

  // An upload by the other admin can be approved, and then it applies
  const [ins] = await db.execute('INSERT INTO hr_import_requests (requested_by, rows_json, summary) VALUES (:by, :rows, :s)', { by: second.id, rows: JSON.stringify(rows), s: '1 new' });
  const ok = await state.admin.call('POST', `/admin/hr/requests/${ins.insertId}/decision`, { decision: 'approve' });
  assert.equal(ok.status, 200);
  const [[added]] = await db.execute("SELECT COUNT(*) AS n FROM staff_directory WHERE staff_number = 'KQ88888'");
  assert.equal(Number(added.n), 1);
  assert.equal((await state.admin.call('POST', `/admin/hr/requests/${ins.insertId}/decision`, { decision: 'approve' })).status, 404);
  await db.execute('DELETE FROM admins WHERE user_id = :id', { id: second.id });
});

/* ---------------- Data rights ---------------- */

test('a member can download their data', async () => {
  const r = await state.joyce.call('GET', '/auth/account/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.equal(r.body.account.email, JOYCE.email);
  assert.equal('password_hash' in r.body.account, false);
});

test('deleting an account removes personal data and ends the session', async () => {
  const [[j]] = await db.execute('SELECT user_id FROM users WHERE email = :e', { e: JOYCE.email });
  await db.execute("INSERT INTO profile_embeddings (user_id, kind, text_hash, vector) VALUES (:id, 'whole', REPEAT('a', 64), '[0.1]')", { id: j.user_id });
  const wrong = await state.joyce.call('POST', '/auth/account/delete', { password: 'nope', code: authenticator.generate(state.joyceSecret) });
  assert.equal(wrong.status, 400);
  const r = await state.joyce.call('POST', '/auth/account/delete', { password: 'Reset2Passw0rd', code: authenticator.generate(state.joyceSecret) });
  assert.equal(r.status, 200);
  const [[u]] = await db.execute("SELECT name, email, staff_number, status FROM users WHERE email LIKE 'deleted-%'");
  assert.equal(u.name, 'Deleted member');
  assert.equal(u.staff_number, null);
  assert.equal(u.status, 'deleted');
  const [[{ vectors }]] = await db.execute('SELECT COUNT(*) AS vectors FROM profile_embeddings WHERE user_id = :id', { id: j.user_id });
  assert.equal(vectors, 0);
  assert.equal((await state.joyce.call('GET', '/auth/account')).status, 401);
  const login = await client().call('POST', '/auth/login', { email: JOYCE.email, password: 'Reset2Passw0rd' });
  assert.equal(login.status, 401);
});

/* ---------------- General protections ---------------- */

/* ---------------- Input sizes and the privacy notice version ---------------- */

test('text longer than the database allows gets a clear message, never a server error', async () => {
  const poster = await makeMember('Long Text Mentor', 'long.text@example.org', 'mentor');
  const x = (n) => 'x'.repeat(n);
  const tooLong = [
    ['title', x(151)], ['company', x(151)], ['location', x(151)], ['industry', x(101)],
    ['applyLink', `https://example.org/${x(250)}`], ['description', x(5001)], ['title', 12345], ['company', ['a', 'b']]
  ];
  for (const [field, value] of tooLong) {
    const r = await poster.me.call('POST', '/opportunities', { ...opp('Ramp agent'), [field]: value });
    assert.equal(r.status, 400, `opportunity ${field}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error);
  }
  // Exactly at the limit is fine
  const atLimit = await poster.me.call('POST', '/opportunities', { ...opp(x(150)), company: x(150), location: x(150) });
  assert.equal(atLimit.status, 201);
  const edit = await poster.me.call('PUT', `/opportunities/${atLimit.body.opportunityId}`, { ...opp('Ramp agent'), description: x(5001) });
  assert.equal(edit.status, 400);

  const event = { title: 'Ramp safety talk', eventDate: inDays(15), mode: 'in_person', location: 'Pride Centre', description: 'Safety on the ramp.' };
  for (const [field, value] of [['title', x(151)], ['location', x(256)], ['description', x(5001)], ['capacity', 10001], ['title', { a: 1 }]]) {
    const r = await poster.me.call('POST', '/events', { ...event, [field]: value });
    assert.equal(r.status, 400, `event ${field}: ${JSON.stringify(r.body)}`);
  }
  const official = await state.admin.call('POST', '/admin/events', { ...event, title: x(151) });
  assert.equal(official.status, 400);
  assert.equal(/at Error|ER_DATA_TOO_LONG/.test(serverLog), false);
});

test('the privacy version matches the date on the privacy notice', () => {
  const page = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'privacy.html'), 'utf8');
  const shown = page.match(/Last updated (\d{1,2} [A-Z][a-z]+ \d{4})/);
  assert.ok(shown, 'privacy.html should say when it was last updated');
  const asDate = new Date(`${shown[1]} 12:00 UTC`).toISOString().slice(0, 10);
  assert.equal(asDate, PRIVACY_VERSION);
});

test('new members record the notice version they accepted', async () => {
  // George registered through the HR email link, Victor through the alumni office
  for (const email of [GEORGE.email, 'victor.new@example.org']) {
    const [[u]] = await db.execute('SELECT user_id, privacy_version FROM users WHERE email = :email', { email });
    assert.equal(u.privacy_version, PRIVACY_VERSION);
    const [[kept]] = await db.execute('SELECT version FROM privacy_acceptances WHERE user_id = :id', { id: u.user_id });
    assert.equal(kept.version, PRIVACY_VERSION);
  }
});

test('a member who accepted an older notice must accept the new one, and can still take their data', async () => {
  const m = await makeMember('Old Notice Member', 'old.notice@example.org', 'mentee');
  await db.execute("UPDATE users SET privacy_version = '2026-08-01' WHERE user_id = :id", { id: m.id });

  const blocked = await m.me.call('GET', '/profile/me');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'privacy_update');
  assert.equal(blocked.body.version, PRIVACY_VERSION);
  // Their data is never held hostage
  const account = await m.me.call('GET', '/auth/account');
  assert.equal(account.status, 200);
  assert.equal(account.body.privacy.accepted, '2026-08-01');
  assert.equal(account.body.privacy.current, PRIVACY_VERSION);
  assert.equal((await m.me.call('GET', '/auth/account/export')).status, 200);

  // An out-of-date page cannot accept a notice the member never saw
  const stale = await m.me.call('POST', '/auth/privacy', { version: '2026-08-01' });
  assert.equal(stale.status, 409);
  const ok = await m.me.call('POST', '/auth/privacy', { version: PRIVACY_VERSION });
  assert.equal(ok.status, 200);
  assert.equal((await m.me.call('GET', '/profile/me')).status, 200);

  const data = await m.me.call('GET', '/auth/account/export');
  assert.equal(data.body.account.privacy_version, PRIVACY_VERSION);
  assert.deepEqual(data.body.privacy_notices_you_accepted.map((p) => p.version), [PRIVACY_VERSION]);
});

test('a backup restores into a fresh database with every row intact', async (t) => {
  const { execFile } = require('node:child_process');
  const os = require('node:os');
  const fs = require('node:fs');
  const run = (script, args, env = {}) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], {
      // A settings file that does not exist, so only the test database settings apply
      env: { ...process.env, BACKUP_DIR: dir, BACKUP_KEY: key, ...env }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: stdout + stderr }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alumnet-backup-'));
  const key = require('node:crypto').randomBytes(32).toString('hex');
  const noEnv = `--env=${path.join(dir, 'none.env')}`;
  try {
    const made = await run('backup.js', [noEnv]);
    assert.equal(made.code, 0, made.out);
    const file = made.out.match(/Saved to (.+\.enc)/)[1].trim();
    // Encrypted: none of the personal data is readable in the file
    assert.equal(fs.readFileSync(file).includes(Buffer.from('example.org')), false);

    const checked = await run('restore-check.js', [noEnv, file]);
    if (/Access denied|command denied/i.test(checked.out)) return t.skip('this database user cannot create the scratch database');
    assert.equal(checked.code, 0, checked.out);
    assert.match(checked.out, /Every table matches the backup/);
    assert.match(checked.out, /023_privacy_version/);

    const wrongKey = await run('restore-check.js', [noEnv, file], { BACKUP_KEY: '0'.repeat(64) });
    assert.notEqual(wrongKey.code, 0);
    assert.match(wrongKey.out, /Could not decrypt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('security headers are set on pages and API responses', async () => {
  const res = await fetch(`${ROOT}/login.html`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('protected routes refuse requests without a session', async () => {
  assert.equal((await client().call('GET', '/profile/me')).status, 401);
});

test('a mentor cannot open admin routes', async () => {
  const victor = client();
  await victor.call('POST', '/auth/login', { email: 'victor.new@example.org', password: 'Passw0rd1' });
  assert.equal((await victor.call('GET', '/admin/users')).status, 403);
});

test('unknown API routes return JSON 404', async () => {
  const r = await client().call('GET', '/does-not-exist');
  assert.equal(r.status, 404);
});

test('repeated failed logins are rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await client().call('POST', '/auth/login', { email: 'ghost@example.org', password: 'wrong' });
  assert.equal(last.status, 429);
  // Counted in the database, so restarting the server does not reset it
  const [[row]] = await db.execute("SELECT hits FROM rate_limits WHERE rl_key LIKE 'sign-in:%' ORDER BY hits DESC LIMIT 1");
  assert.ok(row.hits >= 10);
});
