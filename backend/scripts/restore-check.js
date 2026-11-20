/*
 * Proves a backup can be restored: loads it into a scratch database, then
 * checks that every table has the same number of rows and the same data
 * (SHA-256 of the rows) as when the backup was made.
 *
 *   npm run restore-check                     the newest backup in backend/backups/
 *   npm run restore-check -- backups/alumnet-20261024-1500.sql.gz.enc
 *
 * The scratch database is RESTORE_DB_NAME (default alumnet_restore_test). Its
 * name must end in "_restore_test": it is deleted and rebuilt each time, so
 * it can never be a real database. It is on the server in RESTORE_DB_HOST,
 * RESTORE_DB_USER and RESTORE_DB_PASSWORD, or the DB_* settings when those
 * are not set. Add --keep to leave it in place for a look around.
 *
 * To restore for real after losing the live database, see DEPLOYMENT.md.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { loadEnv, sslConfig, connect, listTables, readRows, unpack } = require('./backup-lib');

// The newest file in the backups folder, when no file is named
function newestBackup() {
  const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^alumnet-.*\.sql\.gz(\.enc)?$/.test(f)).sort() : [];
  if (!files.length) throw new Error(`No backups found in ${dir}. Make one with: npm run backup`);
  const newest = path.join(dir, files[files.length - 1]);
  console.log(`Checking the newest backup: ${files[files.length - 1]}`);
  return newest;
}

async function main() {
  loadEnv();
  const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || newestBackup();
  const name = process.env.RESTORE_DB_NAME || 'alumnet_restore_test';
  if (!/^[A-Za-z0-9_]+_restore_test$/.test(name)) throw new Error('RESTORE_DB_NAME must end in "_restore_test", so a real database is never replaced');

  const sql = unpack(file);
  const firstLine = sql.slice(0, sql.indexOf('\n'));
  const manifest = JSON.parse(firstLine.replace(/^-- /, ''));

  const env = (key) => process.env[`RESTORE_DB_${key}`] || process.env[`DB_${key}`];
  const db = await connect({
    host: env('HOST') || '127.0.0.1', port: env('PORT'), user: env('USER'), password: env('PASSWORD'),
    ssl: process.env.RESTORE_DB_HOST ? sslConfig('RESTORE_DB') : sslConfig()
  });
  const started = Date.now();
  try {
    await db.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(name)}`);
    await db.query(`CREATE DATABASE ${mysql.escapeId(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await db.query(`USE ${mysql.escapeId(name)}`);
    // Backups taken before the ANSI_QUOTES fix quote table names with ".
    // Load those with ANSI_QUOTES on; every value in a backup is in single quotes.
    if (/CREATE TABLE "/.test(sql)) await db.query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',ANSI_QUOTES')");

    // Statements end with ";" and a line break; line breaks inside values are
    // always escaped, so this split never cuts a value in two
    const statements = sql.slice(firstLine.length + 1).split(/;\n/).filter((s) => s.trim());
    for (let i = 0; i < statements.length; i += 50) {
      await db.query(statements.slice(i, i + 50).join(';\n') + ';');
    }

    const problems = [];
    const restoredTables = await listTables(db);
    for (const table of Object.keys(manifest.tables)) {
      if (!restoredTables.includes(table)) { problems.push(`${table}: missing after restore`); continue; }
      const want = manifest.tables[table];
      const got = await readRows(db, table);
      if (got.rows !== want.rows) problems.push(`${table}: ${got.rows} rows, the backup had ${want.rows}`);
      else if (got.sha256 !== want.sha256) problems.push(`${table}: same number of rows but the data differs`);
    }
    const rows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
    const [[applied]] = await db.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'");
    const migrations = Number(applied.n) ? (await db.query('SELECT MAX(filename) AS last FROM schema_migrations'))[0][0].last : 'unknown';

    console.log(`Backup made ${manifest.made_at} from ${manifest.database}`);
    console.log(`Restored ${Object.keys(manifest.tables).length} tables (${rows.toLocaleString('en-US')} rows) into ${name} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log(`Latest migration in the backup: ${migrations}`);
    if (problems.length) {
      problems.forEach((p) => console.error(`  ${p}`));
      throw new Error(`${problems.length} table${problems.length === 1 ? '' : 's'} did not match`);
    }
    console.log('Every table matches the backup.');
  } finally {
    if (!process.argv.includes('--keep')) await db.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(name)}`).catch(() => null);
    await db.end();
  }
}

main().catch((err) => {
  console.error(`Restore check failed: ${err.message}`);
  process.exit(1);
});
