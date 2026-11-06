/*
 * How the live server starts (the container runs `node scripts/start.js`).
 * If the database is not reachable yet, for example the free Aiven plan has
 * powered it off or it is still waking up, the server does not give up and
 * exit. It answers "starting" while it retries the migrations every
 * START_RETRY_SECONDS, then starts AlumNet as soon as the database is back.
 * This is what NFR-05 (recover without manual restarts) relies on.
 */
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const PORT = Number(process.env.PORT || 4000);
const WAIT = Number(process.env.START_RETRY_SECONDS || 15) * 1000;

// Answers while waiting, so the host's health checks and the gateway see a
// clear "starting" reply instead of a closed port
const holding = http.createServer((req, res) => {
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' });
  res.end(JSON.stringify({ error: 'AlumNet is starting. Please try again in a minute.' }));
});

function migrate() {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'migrate.js')], { stdio: 'inherit', env: process.env });
  return run.status === 0;
}

async function main() {
  await new Promise((resolve) => holding.listen(PORT, resolve));
  for (let attempt = 1; ; attempt += 1) {
    if (migrate()) break;
    console.error(`Database not ready (attempt ${attempt}); trying again in ${WAIT / 1000} s`);
    await new Promise((r) => setTimeout(r, WAIT));
  }
  holding.closeAllConnections();
  await new Promise((resolve) => holding.close(resolve));
  require('../src/server');
}

main();
