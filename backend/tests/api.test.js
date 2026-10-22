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

/* ---------------- Trust and safety (Module 2) ---------------- */

// Extra members created straight in the database, for tests that need several people
async function makeMember(name, email, role) {
  const hash = await bcrypt.hash('Passw0rd1', 4);
  const [r] = await db.execute(
    `INSERT INTO users (name, email, password_hash, status, email_verified_at, onboarded_at, privacy_accepted_at)
     VALUES (:name, :email, :hash, 'active', NOW(), NOW(), NOW())`,
    { name, email, hash }
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
  assert.match(logs.body[0].description, /Removed opportunity "Safety analyst" after 3 reports/);
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
  const twice = await state.peter.me.call('PUT', `/opportunities/${state.peterPost}`, clean('Safety Officer'));
  assert.equal(twice.status, 409);
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
  assert.equal(logs.body[0].admin_name, 'Automatic');
  assert.match(logs.body[0].description, /Auto-approved opportunity "Cargo Planner".*Known employer website \(jambojet\.com\)/);
  state.fastPost = fast.body.opportunityId;

  // A website the alumni office has never approved still needs a person
  const newSite = await tess.me.call('POST', '/opportunities', clean('Lounge Manager', 'https://careers.newairline.co.ke/lounge'));
  assert.equal(newSite.body.published, false);
  queue = await state.admin.call('GET', '/admin/moderation');
  assert.ok(findItem(queue, newSite.body.opportunityId).lane_reasons.some((x) => /New website/.test(x)));
});

test('too many posts in a day are held, however trusted the account', async () => {
  const burst = await state.tess.me.call('POST', '/opportunities', clean('Fourth Post Today'));
  assert.equal(burst.body.published, false);
  const queue = await state.admin.call('GET', '/admin/moderation');
  const item = findItem(queue, burst.body.opportunityId);
  assert.equal(item.moderation_lane, 'hold');
  assert.ok(item.lane_reasons.some((x) => /post number 4 in the last 24 hours/.test(x)));
  // Spread the earlier posts out so the next tests are not affected
  await db.execute('UPDATE career_opportunities SET submitted_at = DATE_SUB(NOW(), INTERVAL 2 DAY) WHERE posted_by = :id', { id: state.tess.id });
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
