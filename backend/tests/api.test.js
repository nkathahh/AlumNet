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

const PORT = process.env.TEST_PORT || 4999;
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
    namedPlaceholders: true
  });
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      JWT_SECRET: process.env.JWT_SECRET || 'test-secret',
      APP_URL: ROOT,
      // No email settings, so emails are printed to the log
      SMTP_USER: '', SMTP_PASS: '', BREVO_API_KEY: '', GOOGLE_CLIENT_ID: '', MAIL_DEV_REDIRECT: ''
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
    `INSERT INTO users (name, email, password_hash, status, email_verified_at, onboarded_at) VALUES ('Test Admin', 'admin@example.org', :hash, 'active', NOW(), NOW())`,
    { hash }
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
  const text = r.body.map((l) => l.description).join(' | ');
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
  assert.match(logs.body[0].description, /Suspended George Simiyu \(mentor, /);
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

/* ---------------- Data rights ---------------- */

test('a member can download their data', async () => {
  const r = await state.joyce.call('GET', '/auth/account/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.equal(r.body.account.email, JOYCE.email);
  assert.equal('password_hash' in r.body.account, false);
});

test('deleting an account removes personal data and ends the session', async () => {
  const wrong = await state.joyce.call('POST', '/auth/account/delete', { password: 'nope', code: authenticator.generate(state.joyceSecret) });
  assert.equal(wrong.status, 400);
  const r = await state.joyce.call('POST', '/auth/account/delete', { password: 'Reset2Passw0rd', code: authenticator.generate(state.joyceSecret) });
  assert.equal(r.status, 200);
  const [[u]] = await db.execute("SELECT name, email, staff_number, status FROM users WHERE email LIKE 'deleted-%'");
  assert.equal(u.name, 'Deleted member');
  assert.equal(u.staff_number, null);
  assert.equal(u.status, 'deleted');
  assert.equal((await state.joyce.call('GET', '/auth/account')).status, 401);
  const login = await client().call('POST', '/auth/login', { email: JOYCE.email, password: 'Reset2Passw0rd' });
  assert.equal(login.status, 401);
});

/* ---------------- General protections ---------------- */

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
});
