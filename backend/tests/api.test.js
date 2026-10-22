/*
 * End-to-end API tests for accounts, security and profiles.
 *
 * The tests start the real server against a real MySQL database, so they
 * check actual persistence rather than mocks. They create and change
 * accounts, so they refuse to run unless DB_NAME ends in "_test".
 *
 * Run: npm test   (with DB_* variables pointing at an empty test database
 *                  that has migrations 001 to 010 applied)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { authenticator } = require('otplib');

const PORT = process.env.TEST_PORT || 4999;
const BASE = `http://localhost:${PORT}/api`;

if (!String(process.env.DB_NAME || '').endsWith('_test')) {
  console.error('Refusing to run: DB_NAME must end in "_test" so real data is never touched.');
  process.exit(1);
}

let server;
let serverLog = '';

async function call(method, route, body, token) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: process.env.JWT_SECRET || 'test-secret',
      APP_URL: `http://localhost:${PORT}`,
      // No email settings, so reset links are printed to the log
      SMTP_USER: '', SMTP_PASS: '', BREVO_API_KEY: '', GOOGLE_CLIENT_ID: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not start:\n${serverLog}`);
});

after(() => { if (server) server.kill(); });

// Shared state, built up as the tests run in order
const state = {};
const mentee = {
  role: 'mentee', staffNumber: 'KQ37954', country: 'Kenya', city: 'Nairobi',
  skills: 'Customer service', experience: '3 years cabin crew', careerInterests: 'Training'
};

/* ---------------- Registration ---------------- */

test('rejects a weak password at registration', async () => {
  const r = await call('POST', '/auth/register', { ...mentee, username: 'joyce', password: 'short' });
  assert.equal(r.status, 400);
});

test('rejects an invalid username', async () => {
  const r = await call('POST', '/auth/register', { ...mentee, username: 'Jo', password: 'Passw0rd1' });
  assert.equal(r.status, 400);
});

test('rejects an unknown staff number', async () => {
  const r = await call('POST', '/auth/register', { ...mentee, staffNumber: 'KQ00000', username: 'nobody', password: 'Passw0rd1' });
  assert.equal(r.status, 404);
});

test('registers a mentee verified against the staff directory', async () => {
  const r = await call('POST', '/auth/register', { ...mentee, username: 'Joyce.W', password: 'Passw0rd1' });
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
});

test('reports usernames as taken regardless of capitals', async () => {
  const taken = await call('GET', '/auth/username-available?username=joyce.w');
  assert.equal(taken.body.available, false);
  const free = await call('GET', '/auth/username-available?username=newname');
  assert.equal(free.body.available, true);
});

test('rejects a duplicate username', async () => {
  const r = await call('POST', '/auth/register', {
    role: 'mentor', staffNumber: 'KQ27651', country: 'Kenya', city: 'Mombasa',
    username: 'joyce.w', password: 'Passw0rd1', email: 'dan@example.com'
  });
  assert.equal(r.status, 409);
});

test('registers a mentor with years of experience', async () => {
  const r = await call('POST', '/auth/register', {
    role: 'mentor', staffNumber: 'KQ27651', country: 'Kenya', city: 'Mombasa',
    username: 'daniel', password: 'Passw0rd1', email: 'dan@example.com', yearsOfExperience: 12
  });
  assert.equal(r.status, 201);
  state.mentorToken = r.body.token;
  state.mentorId = r.body.userId;
});

/* ---------------- Sign-in ---------------- */

test('logs in with email', async () => {
  const r = await call('POST', '/auth/login', { identifier: 'joyce.wafula@kenya-airways.com', password: 'Passw0rd1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'mentee');
});

test('logs in with username in any case', async () => {
  const r = await call('POST', '/auth/login', { identifier: 'JOYCE.W', password: 'Passw0rd1' });
  assert.equal(r.status, 200);
  state.token = r.body.token;
});

test('still accepts the older "email" field', async () => {
  const r = await call('POST', '/auth/login', { email: 'joyce.wafula@kenya-airways.com', password: 'Passw0rd1' });
  assert.equal(r.status, 200);
});

test('rejects a wrong password with a generic message', async () => {
  const r = await call('POST', '/auth/login', { identifier: 'joyce.w', password: 'wrong123' });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /Invalid email, username or password/);
});

/* ---------------- Account settings ---------------- */

test('returns account details', async () => {
  const r = await call('GET', '/auth/account', null, state.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.username, 'joyce.w');
  assert.equal(r.body.twoFactorEnabled, false);
});

test('blocks renaming to a taken username', async () => {
  const r = await call('PATCH', '/auth/username', { username: 'daniel' }, state.token);
  assert.equal(r.status, 409);
});

test('renames the username', async () => {
  const r = await call('PATCH', '/auth/username', { username: 'joyce_wafula' }, state.token);
  assert.equal(r.status, 200);
});

test('requires the correct current password to change it', async () => {
  const r = await call('POST', '/auth/change-password', { currentPassword: 'nope1234', newPassword: 'NewPassw0rd' }, state.token);
  assert.equal(r.status, 401);
});

test('changes the password and the new one works', async () => {
  const r = await call('POST', '/auth/change-password', { currentPassword: 'Passw0rd1', newPassword: 'NewPassw0rd' }, state.token);
  assert.equal(r.status, 200);
  const login = await call('POST', '/auth/login', { identifier: 'joyce_wafula', password: 'NewPassw0rd' });
  assert.equal(login.status, 200);
});

/* ---------------- Forgot and reset password ---------------- */

test('gives the same reply for unknown accounts', async () => {
  const r = await call('POST', '/auth/forgot-password', { identifier: 'nobody@example.com' });
  assert.equal(r.status, 200);
  assert.ok(r.body.message);
});

test('creates a reset link for a known account', async () => {
  const r = await call('POST', '/auth/forgot-password', { identifier: 'joyce_wafula' });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 300));
  const match = [...serverLog.matchAll(/reset-password\.html\?token=([a-f0-9]{64})/g)].pop();
  assert.ok(match, 'reset link should be logged when email is not configured');
  state.resetToken = match[1];
});

test('rejects a weak password on reset', async () => {
  const r = await call('POST', '/auth/reset-password', { token: state.resetToken, password: 'weak' });
  assert.equal(r.status, 400);
});

test('resets the password with the link', async () => {
  const r = await call('POST', '/auth/reset-password', { token: state.resetToken, password: 'Reset2Passw0rd' });
  assert.equal(r.status, 200);
});

test('a reset link works only once', async () => {
  const r = await call('POST', '/auth/reset-password', { token: state.resetToken, password: 'Another1pass' });
  assert.equal(r.status, 400);
});

test('logs in with the reset password', async () => {
  const r = await call('POST', '/auth/login', { identifier: 'joyce_wafula', password: 'Reset2Passw0rd' });
  assert.equal(r.status, 200);
  state.token = r.body.token;
});

/* ---------------- Two-factor authentication ---------------- */

test('starts two-factor setup with a QR code', async () => {
  const r = await call('POST', '/auth/2fa/setup', null, state.token);
  assert.equal(r.status, 200);
  assert.ok(r.body.qr.startsWith('data:image/png'));
  state.secret = r.body.secret;
});

test('will not enable two-factor with a wrong code', async () => {
  const r = await call('POST', '/auth/2fa/enable', { code: '000000' }, state.token);
  assert.equal(r.status, 400);
});

test('enables two-factor with a valid code', async () => {
  const r = await call('POST', '/auth/2fa/enable', { code: authenticator.generate(state.secret) }, state.token);
  assert.equal(r.status, 200);
});

test('asks for a code after the password when two-factor is on', async () => {
  const r = await call('POST', '/auth/login', { identifier: 'joyce_wafula', password: 'Reset2Passw0rd' });
  assert.equal(r.status, 200);
  assert.equal(r.body.twoFactorRequired, true);
  assert.equal(r.body.token, undefined);
  state.tempToken = r.body.tempToken;
});

test('the temporary two-factor token cannot be used as a login session', async () => {
  const r = await call('GET', '/profile/me', null, state.tempToken);
  assert.equal(r.status, 401);
});

test('rejects a wrong two-factor code', async () => {
  const r = await call('POST', '/auth/2fa/verify', { tempToken: state.tempToken, code: '123456' });
  assert.equal(r.status, 401);
});

test('completes sign-in with a valid two-factor code', async () => {
  const r = await call('POST', '/auth/2fa/verify', { tempToken: state.tempToken, code: authenticator.generate(state.secret) });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'mentee');
  state.token = r.body.token;
});

test('needs the password to turn two-factor off', async () => {
  const r = await call('POST', '/auth/2fa/disable', { password: 'wrong', code: authenticator.generate(state.secret) }, state.token);
  assert.equal(r.status, 401);
});

test('turns two-factor off with password and code', async () => {
  const r = await call('POST', '/auth/2fa/disable', { password: 'Reset2Passw0rd', code: authenticator.generate(state.secret) }, state.token);
  assert.equal(r.status, 200);
});

/* ---------------- Profiles ---------------- */

test('rejects a non-LinkedIn profile link', async () => {
  const r = await call('PUT', '/profile/me', { linkedinUrl: 'http://evil.example.com' }, state.token);
  assert.equal(r.status, 400);
});

test('a partial profile update keeps the other fields', async () => {
  const r = await call('PUT', '/profile/me', {
    headline: 'Cabin Crew | Aspiring Trainer', bio: 'Hello',
    linkedinUrl: 'https://www.linkedin.com/in/joyce-wafula', city: 'Kisumu'
  }, state.token);
  assert.equal(r.status, 200);
  const me = await call('GET', '/profile/me', null, state.token);
  assert.equal(me.body.skills, 'Customer service');
  assert.equal(me.body.headline, 'Cabin Crew | Aspiring Trainer');
  assert.equal(me.body.city, 'Kisumu');
});

test('a mentor can update years of experience', async () => {
  const r = await call('PUT', '/profile/me', { yearsOfExperience: 15, headline: 'Retired Captain' }, state.mentorToken);
  assert.equal(r.status, 200);
});

test('the public profile hides the email address', async () => {
  const r = await call('GET', `/profile/${state.mentorId}`, null, state.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.years_of_experience, 15);
  assert.equal(r.body.role, 'mentor');
  assert.equal('email' in r.body, false);
});

/* ---------------- Access control and configuration ---------------- */

test('protected routes refuse requests without a token', async () => {
  const r = await call('GET', '/profile/me');
  assert.equal(r.status, 401);
});

test('a mentee cannot open admin routes', async () => {
  const r = await call('GET', '/admin/users', null, state.token);
  assert.equal(r.status, 403);
});

test('Google sign-in reports when it is not configured', async () => {
  const r = await call('POST', '/auth/google', { credential: 'x' });
  assert.equal(r.status, 503);
});

test('unknown API routes return JSON 404', async () => {
  const r = await call('GET', '/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'Not found');
});

test('repeated failed logins are rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) {
    last = await call('POST', '/auth/login', { identifier: 'ghost', password: 'wrong' });
  }
  assert.equal(last.status, 429);
});
