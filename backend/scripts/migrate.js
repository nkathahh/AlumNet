/*
 * Database migrations, applied in order and recorded, so each one runs
 * exactly once on every database (your laptop, CI, the live site).
 *
 *   npm run migrate                      apply every migration not yet applied
 *   npm run migrate -- --status          list what is applied and what is waiting
 *   npm run migrate -- --baseline=021    mark 001 to 021 as already applied without
 *                                        running them (for a database that was set
 *                                        up by hand before this runner existed)
 *
 * Uses the DB_* settings from backend/.env. Each file is recorded with a
 * checksum: if an applied file is later edited, the runner warns instead of
 * silently running a different history.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

function sslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  if (process.env.DB_SSL_CA) return { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

const checksum = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslConfig(),
    multipleStatements: true,
    timezone: '+03:00'
  });
  try {
    await db.query("SET time_zone = '+03:00'");
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(190) PRIMARY KEY,
      checksum CHAR(16) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      baseline TINYINT(1) NOT NULL DEFAULT 0
    )`);
    const [rows] = await db.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    // A database set up by hand: record what is already there, run nothing
    const baseline = flagValue('baseline');
    if (baseline) {
      const upTo = files.filter((f) => f.slice(0, 3) <= baseline.padStart(3, '0').slice(0, 3));
      if (!upTo.length) throw new Error(`No migrations up to ${baseline}`);
      for (const f of upTo) {
        if (applied.has(f)) continue;
        const text = fs.readFileSync(path.join(DIR, f), 'utf8');
        await db.execute('INSERT INTO schema_migrations (filename, checksum, baseline) VALUES (?, ?, 1)', [f, checksum(text)]);
      }
      console.log(`Marked ${upTo.length} migrations (up to ${upTo[upTo.length - 1]}) as already applied. Nothing was run.`);
      return;
    }

    // Edited after being applied: say so, but do not stop (comments and fixes happen)
    for (const f of files) {
      if (!applied.has(f)) continue;
      const now = checksum(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (applied.get(f) !== now) console.warn(`Warning: ${f} has changed since it was applied. It will not run again.`);
    }

    const waiting = files.filter((f) => !applied.has(f));
    if (flag('status')) {
      console.log(`Applied: ${files.length - waiting.length} of ${files.length}`);
      waiting.forEach((f) => console.log(`  waiting: ${f}`));
      return;
    }
    if (!waiting.length) { console.log('Database is up to date.'); return; }

    // A fresh database that already has tables means it was set up by hand
    if (!applied.size) {
      const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'");
      if (Number(n) && !flag('force')) {
        throw new Error('This database already has tables but no migration history. Run "npm run migrate -- --baseline=NNN" '
          + 'with the number of the last migration you applied by hand (for example 021), then run "npm run migrate" again.');
      }
    }

    for (const f of waiting) {
      const text = fs.readFileSync(path.join(DIR, f), 'utf8');
      process.stdout.write(`Applying ${f} ... `);
      try {
        await db.query(text);
      } catch (err) {
        console.log('failed');
        // MySQL cannot roll back table changes, so stop here and leave the rest waiting
        throw new Error(`${f} failed: ${err.message}. Earlier migrations in this run were applied; fix this one and run again.`);
      }
      await db.execute('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [f, checksum(text)]);
      console.log('done');
    }
    console.log(`Applied ${waiting.length} migration${waiting.length === 1 ? '' : 's'}.`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
