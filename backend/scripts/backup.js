/*
 * Makes a full backup of the AlumNet database into backend/backups/.
 *
 *   npm run backup                          the database in backend/.env
 *   npm run backup -- --env=.env.live       the database in another settings file
 *
 * Files go to backend/backups/ (or BACKUP_DIR), which git ignores.
 *
 * Aiven's free plan keeps a single backup for its own disaster recovery and
 * powers off idle services, so AlumNet keeps its own copies as well.
 *
 * The file holds personal data, password hashes and encrypted two-factor
 * secrets. Set BACKUP_KEY (64 hexadecimal characters) so the file is
 * encrypted, keep the key somewhere other than the backups, and never commit
 * either. Check a backup with: npm run restore-check -- <file>
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { loadEnv, sslConfig, connect, listTables, readRows, pack } = require('./backup-lib');

const MAX_STATEMENT = 512 * 1024; // well under MySQL's max_allowed_packet

async function main() {
  const envFile = loadEnv();
  const outDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
  const db = await connect({
    host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, ssl: sslConfig()
  });
  try {
    // One consistent snapshot of every table, even while people use the site
    await db.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');

    const tables = await listTables(db);
    const manifest = { app: 'AlumNet', made_at: new Date().toISOString(), database: process.env.DB_NAME, tables: {} };
    const parts = ["SET FOREIGN_KEY_CHECKS = 0;", "SET time_zone = '+03:00';"];

    for (const table of tables) {
      const [[created]] = await db.query(`SHOW CREATE TABLE ${mysql.escapeId(table)}`);
      parts.push(`DROP TABLE IF EXISTS ${mysql.escapeId(table)};`);
      parts.push(`${created['Create Table']};`);
      let batch = [];
      let size = 0;
      const flush = () => {
        if (!batch.length) return;
        parts.push(`INSERT INTO ${mysql.escapeId(table)} VALUES ${batch.join(',')};`);
        batch = [];
        size = 0;
      };
      manifest.tables[table] = await readRows(db, table, (values) => {
        if (size + values.length > MAX_STATEMENT) flush();
        batch.push(values);
        size += values.length;
      });
      flush();
    }
    await db.query('COMMIT');
    parts.push('SET FOREIGN_KEY_CHECKS = 1;');

    const sql = `-- ${JSON.stringify(manifest)}\n${parts.join('\n')}\n`;
    fs.mkdirSync(outDir, { recursive: true });
    // Named by Nairobi time, for example alumnet-20261024-1500
    const nairobi = new Date(Date.now() + 3 * 3600e3).toISOString();
    const stamp = `${nairobi.slice(0, 10).replace(/-/g, '')}-${nairobi.slice(11, 16).replace(':', '')}`;
    const file = path.join(outDir, `alumnet-${stamp}.sql.gz${process.env.BACKUP_KEY ? '.enc' : ''}`);
    fs.writeFileSync(file, pack(sql), { mode: 0o600 });

    const rows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
    console.log(`Backed up ${tables.length} tables (${rows.toLocaleString('en-US')} rows) from ${process.env.DB_NAME} using ${path.basename(envFile)}`);
    console.log(`Saved to ${file}`);
    if (!process.env.BACKUP_KEY) console.warn('Warning: BACKUP_KEY is not set, so this file is NOT encrypted. Store it somewhere private.');
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
});
