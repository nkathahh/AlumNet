/*
 * Browser checks that the API tests cannot do:
 *
 * 1. Stored XSS. Every field a member can type into is filled with script
 *    payloads, then every page that shows that text is opened in a real
 *    browser as each role. The test fails if a payload runs (window.__xss
 *    is set or a dialog opens) or if it is injected into the page at all,
 *    even where the Content Security Policy stops it from running. This
 *    checks that escapeHTML is used everywhere text is turned into HTML.
 * 2. Accessibility. axe-core checks the main pages against WCAG 2.1 A and AA
 *    and the test fails on any "critical" or "serious" problem.
 *
 * Run: npm test (from this folder), with the same DB_* variables as the API
 * tests. DB_NAME must end in "_test". The backend's packages must be installed.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const mysql = require('mysql2/promise');
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');

if (!String(process.env.DB_NAME || '').endsWith('_test')) {
  console.error('Refusing to run: DB_NAME must end in "_test" so real data is never touched.');
  process.exit(1);
}

const backendRequire = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
// Only the database connection comes from backend/.env (anything set in the terminal wins)
try {
  const local = backendRequire('dotenv').parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'backend', '.env')));
  for (const [k, v] of Object.entries(local)) if (k.startsWith('DB_') && process.env[k] === undefined) process.env[k] = v;
} catch { /* no .env (as in CI) */ }
const bcrypt = backendRequire('bcrypt');
const { PRIVACY_VERSION } = require('../backend/src/utils/privacy');

const PORT = process.env.E2E_PORT || 4998;
const ROOT = `http://localhost:${PORT}`;
const PASSWORD = 'Passw0rd1';
const P1 = '"><img src=x onerror="window.__xss=1">';
const P2 = '<script>window.__xss=1</script>';
const P3 = "'><svg onload=window.__xss=1>";
const PAYLOAD = `${P1}${P2}${P3}`;

let server; let db; let browser; let serverLog = '';
const ids = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function member(name, email, role, privacyVersion = PRIVACY_VERSION) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const [r] = await db.execute(
    `INSERT INTO users (name, email, password_hash, status, email_verified_at, onboarded_at, privacy_accepted_at, privacy_version, department)
     VALUES (:name, :email, :hash, 'active', NOW(), NOW(), NOW(), :privacyVersion, 'Human Resources')`,
    { name, email, hash, privacyVersion }
  );
  const table = { mentor: 'mentors', mentee: 'mentees', admin: 'admins' }[role];
  await db.execute(`INSERT INTO ${table} (user_id) VALUES (:id)`, { id: r.insertId });
  if (role !== 'admin') await db.execute('INSERT INTO profiles (user_id) VALUES (:id)', { id: r.insertId });
  return r.insertId;
}

async function page(email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await context.newPage();
  pg.problems = [];
  pg.on('dialog', async (d) => { pg.problems.push(`dialog: ${d.message()}`); await d.dismiss(); });
  pg.on('pageerror', (e) => pg.problems.push(`page error: ${e.message}`));
  await pg.goto(`${ROOT}/login.html`);
  await pg.fill('#email', email);
  await pg.fill('#password', PASSWORD);
  await pg.click('#login-form button[type=submit]');
  await pg.waitForURL((u) => !u.pathname.endsWith('login.html'));
  return pg;
}

// Calls the API from inside the page, with its session cookie
const api = (pg, method, route, body) => pg.evaluate(async ([m, r, b]) => {
  const res = await fetch(`/api${r}`, {
    method: m, credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AlumNet' },
    body: b ? JSON.stringify(b) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, route, body]);

async function visit(pg, url, after) {
  await pg.goto(ROOT + url);
  await pg.waitForLoadState('networkidle');
  if (after) await after(pg);
  await wait(300);
  const fired = await pg.evaluate(() => window.__xss === 1);
  assert.equal(fired, false, `A script payload ran on ${url}`);
  // The Content Security Policy blocks inline scripts, so a payload could be
  // injected without running. Check the page itself for injected elements too.
  const injected = await pg.evaluate(() => [
    ...document.querySelectorAll('img[src="x"], svg[onload], [onerror], [onload]'),
    ...[...document.querySelectorAll('script:not([src])')].filter((el) => el.textContent.includes('__xss'))
  ].map((el) => el.outerHTML.slice(0, 80)));
  assert.deepEqual(injected, [], `Text was turned into HTML on ${url}`);
  assert.deepEqual(pg.problems.filter((p) => p.startsWith('dialog')), [], `A dialog opened on ${url}`);
}

before(async () => {
  db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, namedPlaceholders: true,
    // Same clock as the app (Nairobi time), whatever time zone the database server uses
    timezone: '+03:00'
  });
  await db.query("SET time_zone = '+03:00'");
  server = spawn(process.execPath, [path.join(__dirname, '..', 'backend', 'src', 'server.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(PORT), JWT_SECRET: 'e2e-secret', APP_URL: ROOT,
      ADMIN_2FA_REQUIRED: 'false', ML_SERVICE_URL: 'http://127.0.0.1:1', SMTP_USER: '', SMTP_PASS: '', BREVO_API_KEY: '', MAIL_DEV_REDIRECT: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${ROOT}/health`)).ok) break; } catch { /* not up yet */ }
    await wait(200);
  }
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  ids.admin = await member('E2E Admin', 'e2e.admin@example.org', 'admin');
  ids.mentor = await member(`Mentor ${P1}`, 'e2e.mentor@example.org', 'mentor');
  ids.mentee = await member(`Mentee ${P3}`, 'e2e.mentee@example.org', 'mentee');
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
  if (db) await db.end();
});

test('script typed into any field never runs, on any page, for any role', async () => {
  const mentor = await page('e2e.mentor@example.org');
  const mentee = await page('e2e.mentee@example.org');
  const admin = await page('e2e.admin@example.org');

  // Every free-text field members fill in
  const profile = { headline: `Head ${PAYLOAD}`, bio: `Bio ${PAYLOAD}`, skills: `Excel, ${P1}, ${P2}`, experience: `Exp ${PAYLOAD}`, careerInterests: `Goals ${PAYLOAD}`, city: `Nairobi ${P3}` };
  assert.equal((await api(mentor, 'PUT', '/profile/me', { ...profile, availabilityNote: `Free ${PAYLOAD}` })).status, 200);
  assert.equal((await api(mentee, 'PUT', '/profile/me', profile)).status, 200);

  const opp = await api(mentor, 'POST', '/opportunities', {
    title: `Role ${P1}`, company: `Co ${P2}`, opportunityType: 'full_time', industry: 'Aviation', location: `JKIA ${P3}`,
    description: `About ${PAYLOAD}`, applyLink: 'https://careers.kenya-airways.com/x', closingDate: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10),
    requiredSkills: `Excel, ${P1}`
  });
  assert.equal(opp.status, 201);
  const event = await api(mentor, 'POST', '/events', {
    title: `Event ${P1}`, eventDate: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 16), mode: 'in_person',
    location: `Venue ${P2}`, description: `About ${PAYLOAD}`, topics: `Excel, ${P3}`, capacity: 10
  });
  assert.equal(event.status, 201);
  await api(admin, 'POST', `/admin/moderation/opportunity/${opp.body.opportunityId}/decision`, { decision: 'approved' });
  await api(admin, 'POST', `/admin/moderation/event/${event.body.eventId}/decision`, { decision: 'approved' });
  await api(mentee, 'POST', `/events/${event.body.eventId}/register`);
  const req = await api(mentee, 'POST', '/mentorship-requests', { mentorId: ids.mentor, message: `Please mentor me ${PAYLOAD}` });
  assert.equal(req.status, 201);
  await api(mentee, 'POST', '/safety/reports', { targetType: 'opportunity', targetId: opp.body.opportunityId, reason: 'misleading', details: `Odd ${PAYLOAD}` });
  // A second, edited event so change notices with the title are shown too
  await api(mentor, 'PUT', `/events/${event.body.eventId}`, {
    title: `Event ${P1}`, eventDate: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 16), mode: 'in_person',
    location: `New venue ${P2}`, description: `About ${PAYLOAD}`, topics: `Excel, ${P3}`, capacity: 10
  });

  for (const url of ['/mentee-dashboard.html', '/recommendations.html', `/opportunities.html?open=${opp.body.opportunityId}`,
    '/events.html', '/notifications.html', '/requests.html', `/profile.html?id=${ids.mentor}`, '/settings.html']) {
    await visit(mentee, url);
  }
  for (const url of ['/mentor-dashboard.html', '/requests.html', '/events.html', `/profile.html?id=${ids.mentee}`, '/notifications.html']) {
    await visit(mentor, url);
  }
  // The mentorship workspace: goals and meeting notes both people can see
  const rid = req.body.request_id;
  assert.equal((await api(mentor, 'PATCH', `/mentorship-requests/${rid}`, { decision: 'accepted' })).status, 200);
  assert.equal((await api(mentee, 'POST', `/mentorship-requests/${rid}/goals`, { text: `Goal ${P1}${P2}` })).status, 201);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Nairobi' });
  assert.equal((await api(mentor, 'POST', `/mentorship-requests/${rid}/meetings`, { metOn: today, mode: 'virtual', minutes: 30, note: `Note ${PAYLOAD}` })).status, 201);
  for (const pg of [mentee, mentor]) {
    await visit(pg, '/requests.html#accepted', async (p) => { await p.click('[data-workspace]'); await wait(600); });
  }
  await visit(mentor, '/events.html', (pg) => pg.click('[data-event-filter=proposals]'));
  await visit(mentor, '/opportunities.html', (pg) => pg.click('text=My posts'));
  await visit(mentor, '/opportunities.html', (pg) => pg.click('[data-open-opp], .opportunity-card >> nth=0').catch(() => null));
  // One member in detail, as the admin sees them
  // (a different query string each time, so the page really reloads and no dialog is left open)
  await visit(admin, '/admin.html?d=1#users', async (pg) => { await pg.click('[data-admin-tab=users]'); await wait(500); await pg.click(`[data-user-detail="${ids.mentor}"]`); await wait(800); });
  await visit(admin, '/admin.html?d=2#users', async (pg) => { await pg.click('[data-admin-tab=users]'); await wait(500); await pg.click(`[data-user-detail="${ids.mentee}"]`); await wait(800); });
  for (const tab of ['overview', 'verification', 'reports', 'users', 'hr', 'events', 'opportunities', 'impact', 'logs']) {
    await visit(admin, `/admin.html#${tab}`, async (pg) => { await pg.click(`[data-admin-tab=${tab}]`); await wait(400); });
  }
});

test('the main pages have no serious accessibility problems (WCAG 2.1 AA, axe-core)', async () => {
  const mentee = await page('e2e.mentee@example.org');
  const results = [];
  const check = async (pg, url) => {
    await pg.goto(ROOT + url);
    await pg.waitForLoadState('networkidle');
    const r = await new AxeBuilder({ page: pg }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    for (const v of r.violations) if (['critical', 'serious'].includes(v.impact)) results.push(`${url}: ${v.id} (${v.nodes.length}) ${v.help}`);
  };
  const anon = await (await browser.newContext()).newPage();
  for (const url of ['/login.html', '/signup.html', '/forgot-password.html']) await check(anon, url);
  for (const url of ['/mentee-dashboard.html', '/recommendations.html', '/opportunities.html', '/events.html', '/notifications.html', '/profile.html', '/settings.html']) {
    await check(mentee, url);
  }
  // Admin screens with the most data on them, in light and dark mode
  const admin = await page('e2e.admin@example.org');
  for (const [i, tab] of ['users', 'impact', 'logs'].entries()) {
    for (const theme of ['light', 'dark']) {
      await admin.goto(`${ROOT}/admin.html?a=${i}${theme}#${tab}`);
      await admin.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await admin.click(`[data-admin-tab=${tab}]`);
      await admin.waitForLoadState('networkidle');
      await wait(500);
      const r = await new AxeBuilder({ page: admin }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of r.violations) if (['critical', 'serious'].includes(v.impact)) results.push(`admin ${tab} (${theme}): ${v.id} (${v.nodes.length}) ${v.help}`);
    }
  }
  assert.deepEqual(results, [], `Accessibility problems:\n${results.join('\n')}`);
});

test('keyboard focus stays inside a dialog and returns to the button that opened it', async () => {
  const mentee = await page('e2e.mentee@example.org');
  await mentee.goto(`${ROOT}/settings.html`);
  await mentee.waitForLoadState('networkidle');
  await mentee.focus('#logout-everywhere');
  await mentee.keyboard.press('Enter');
  await wait(300);
  for (let i = 0; i < 12; i++) {
    await mentee.keyboard.press('Tab');
    const inside = await mentee.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('.modal-backdrop')));
    assert.equal(inside, true, `Tab ${i + 1} left the dialog`);
  }
  await mentee.keyboard.press('Escape');
  await wait(200);
  assert.equal(await mentee.evaluate(() => document.activeElement && document.activeElement.id), 'logout-everywhere');
});

test('pages fit a phone screen without sideways scrolling', async () => {
  const wide = [];
  for (const [email, urls] of [
    ['e2e.mentee@example.org', ['/mentee-dashboard.html', '/recommendations.html', '/opportunities.html', '/events.html', '/requests.html', '/notifications.html', '/profile.html', '/settings.html']],
    ['e2e.admin@example.org', ['/admin.html?m=1#users', '/admin.html?m=2#verification', '/admin.html?m=3#reports', '/admin.html?m=4#events', '/admin.html?m=5#opportunities', '/admin.html?m=6#impact', '/admin.html?m=7#logs']]
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const pg = await ctx.newPage();
    await pg.goto(`${ROOT}/login.html`);
    await pg.fill('#email', email);
    await pg.fill('#password', PASSWORD);
    await pg.click('#login-form button[type=submit]');
    await pg.waitForURL((u) => !u.pathname.endsWith('login.html'));
    for (const url of urls) {
      await pg.goto(ROOT + url);
      await pg.waitForLoadState('networkidle');
      await wait(400);
      const width = await pg.evaluate(() => document.documentElement.scrollWidth);
      if (width > 392) wide.push(`${url}: ${width}px`);
    }
    await ctx.close();
  }
  assert.deepEqual(wide, [], `Wider than a 390px phone:\n${wide.join('\n')}`);
});

test('a member asked to accept a changed privacy notice can accept it, or still reach their data', async () => {
  await member('Old Notice', 'e2e.old.notice@example.org', 'mentee', '2026-08-01');
  const pg = await page('e2e.old.notice@example.org');
  await pg.waitForLoadState('networkidle');
  const dlg = pg.getByRole('dialog', { name: 'We updated our privacy notice' });
  await dlg.waitFor();
  // It cannot be closed with Escape: the server refuses everything else anyway
  await pg.keyboard.press('Escape');
  assert.equal(await dlg.isVisible(), true);
  const a11y = await new AxeBuilder({ page: pg }).include('.modal-card').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  assert.deepEqual(a11y.violations.filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => v.id), []);

  // Account settings shows a banner instead, so data can still be downloaded
  await pg.goto(`${ROOT}/settings.html`);
  await pg.waitForLoadState('networkidle');
  await pg.locator('#privacy-banner').waitFor();
  assert.equal(await pg.getByRole('dialog').count(), 0);
  assert.equal(await pg.locator('#st-name').textContent(), 'Old Notice');

  // Accepting saves, then reloads the page: wait for that reload, not just the click
  await Promise.all([pg.waitForEvent('load'), pg.locator('#privacy-banner button').click()]);
  await pg.waitForLoadState('networkidle');
  assert.equal(await pg.locator('#privacy-banner').count(), 0);
  assert.equal((await api(pg, 'GET', '/profile/me')).status, 200);
  assert.deepEqual(pg.problems.filter((p) => p.startsWith('page error')), []);
  await pg.context().close();
});
