/*
 * End-to-end response times as a member sees them (NFR-01), measured through
 * the real backend, with the ML service running and its cache warm.
 *
 * Start the ML service and the backend (npm run dev), then from backend:
 *   npm run latency -- --email sharon@example.org --password Passw0rd1
 *   npm run latency -- --email ... --password ... --url https://your-site.onrender.com --runs 20
 *
 * Use a mentee whose profile is complete. For each page it makes one warm-up
 * request (not counted), then --runs requests one after another, then the
 * same number at the same moment, to see what happens when several people
 * use AlumNet together. The result is saved for the report.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg('url', 'http://localhost:4000').replace(/\/$/, '');
const RUNS = Math.max(3, Math.min(50, Number(arg('runs', 10))));
const TARGET_S = 3;

const ENDPOINTS = [
  ['Mentor recommendations', '/api/recommendations'],
  ['Mentor search (by meaning)', '/api/mentors?q=leadership%20and%20safety'],
  ['Events with fit labels', '/api/events'],
  ['Opportunities with fit labels', '/api/opportunities'],
  ['Mentee dashboard summary', '/api/dashboard/mentee-summary']
];

let cookie = '';
async function call(route, init = {}) {
  const start = process.hrtime.bigint();
  const res = await fetch(BASE + route, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AlumNet', Cookie: cookie, ...(init.headers || {}) }
  });
  await res.arrayBuffer();
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  for (const c of res.headers.getSetCookie()) if (c.startsWith('alumnet_session=')) cookie = c.split(';')[0];
  return { status: res.status, seconds };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const r3 = (x) => Math.round(x * 1000) / 1000;

async function main() {
  const email = arg('email');
  const password = arg('password');
  if (!email || !password) throw new Error('Give a mentee account: npm run latency -- --email you@example.org --password ...');
  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (login.status !== 200 || !cookie) throw new Error(`Could not sign in (status ${login.status}). Use a mentee account without two-factor.`);

  const rows = [];
  for (const [name, route] of ENDPOINTS) {
    const warm = await call(route);
    if (warm.status !== 200) {
      console.log(`${name}: skipped (status ${warm.status}${warm.status === 409 ? ': this mentee\'s profile is not complete enough for matching' : ''})`);
      continue;
    }
    const one = [];
    for (let i = 0; i < RUNS; i++) one.push((await call(route)).seconds);
    const together = await Promise.all(Array.from({ length: RUNS }, () => call(route)));
    const ok = together.filter((t) => t.status === 200).map((t) => t.seconds);
    rows.push({
      page: name, route,
      one_at_a_time: { median_s: r3(median(one)), p95_s: r3(pct(one, 95)), max_s: r3(Math.max(...one)) },
      [`${RUNS}_at_once`]: ok.length ? { median_s: r3(median(ok)), p95_s: r3(pct(ok, 95)), max_s: r3(Math.max(...ok)), refused: RUNS - ok.length } : { refused: RUNS },
      meets_target: median(one) <= TARGET_S
    });
  }

  console.log(`\nResponse times from ${BASE}, ${RUNS} requests each (target: median under ${TARGET_S} s)\n`);
  console.log(`${'Page'.padEnd(32)}${'Median'.padStart(9)}${'95%'.padStart(9)}${`${RUNS} at once`.padStart(14)}  Target`);
  for (const r of rows) {
    const burst = r[`${RUNS}_at_once`];
    console.log(`${r.page.padEnd(32)}${(r.one_at_a_time.median_s.toFixed(2) + ' s').padStart(9)}${(r.one_at_a_time.p95_s.toFixed(2) + ' s').padStart(9)}${(burst.median_s !== undefined ? burst.median_s.toFixed(2) + ' s' : 'refused').padStart(14)}  ${r.meets_target ? 'PASS' : 'FAIL'}`);
  }
  const limited = rows.filter((r) => r[`${RUNS}_at_once`].refused);
  if (limited.length) console.log('\nSome requests made at once were refused by the rate limit (expected for the mentor search, which allows a set number per minute).');

  const out = { measured_at: new Date().toISOString(), base_url: BASE, runs: RUNS, target_seconds: TARGET_S, node: process.version, results: rows };
  const dir = path.join(__dirname, '..', '..', 'ml-service', 'evaluation', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `latency_end_to_end_${out.measured_at.slice(0, 19).replace(/[-:T]/g, '')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${file}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
