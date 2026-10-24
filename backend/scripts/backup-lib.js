/*
 * Shared by backup.js and restore-check.js.
 *
 * A backup is one file: the SQL to rebuild every table and its rows,
 * gzipped, and encrypted with AES-256-GCM when BACKUP_KEY is set. Its first
 * line is a manifest with the number of rows in each table and a SHA-256 of
 * those rows, so a restore can prove that every row came back unchanged.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const MAGIC = Buffer.from('ALUMNETBK1');

// --env=path loads another settings file (for example the live database's)
function loadEnv() {
  const flag = process.argv.find((a) => a.startsWith('--env='));
  const file = flag ? path.resolve(flag.slice(6)) : path.join(__dirname, '..', '.env');
  require('dotenv').config({ path: file });
  return file;
}

function sslConfig(prefix = 'DB') {
  if (process.env[`${prefix}_SSL`] !== 'true') return undefined;
  const ca = process.env[`${prefix}_SSL_CA`];
  if (ca) return { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

/*
 * Values come back exactly as stored: dates as text (no time zone
 * conversion), JSON as its text, big numbers as text. Reading the original
 * and the restored copy the same way is what makes the checksums comparable.
 */
async function connect({ host, port, user, password, database, ssl }) {
  const db = await mysql.createConnection({
    host, port: Number(port || 3306), user, password, database, ssl,
    multipleStatements: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: '+03:00',
    typeCast: (field, next) => (field.type === 'JSON' ? field.string() : next())
  });
  await db.query("SET time_zone = '+03:00'");
  return db;
}

async function listTables(db) {
  const [rows] = await db.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name"
  );
  return rows.map((r) => r.name || r.NAME || r.TABLE_NAME);
}

// Rows in a fixed order (primary key, or every column when there is none)
async function orderBy(db, table) {
  const [keys] = await db.query(
    `SELECT column_name AS c FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`,
    [table]
  );
  if (keys.length) return keys.map((k) => mysql.escapeId(k.c || k.C || k.COLUMN_NAME)).join(', ');
  const [cols] = await db.query(
    'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
    [table]
  );
  return cols.map((k) => mysql.escapeId(k.c || k.C || k.COLUMN_NAME)).join(', ');
}

// Calls onRow(sqlValues) for each row, and returns the count and checksum
async function readRows(db, table, onRow) {
  const [rows] = await db.query({ sql: `SELECT * FROM ${mysql.escapeId(table)} ORDER BY ${await orderBy(db, table)}`, rowsAsArray: true });
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    const values = `(${row.map((v) => mysql.escape(v)).join(',')})`;
    hash.update(values).update('\n');
    if (onRow) onRow(values);
  }
  return { rows: rows.length, sha256: hash.digest('hex') };
}

function seal(buffer) {
  const key = process.env.BACKUP_KEY;
  if (!key) return buffer;
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('BACKUP_KEY must be 64 hexadecimal characters (32 bytes)');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function unseal(buffer) {
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) return buffer;
  const key = process.env.BACKUP_KEY;
  if (!key) throw new Error('This backup is encrypted. Set BACKUP_KEY to the key it was made with.');
  const iv = buffer.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buffer.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buffer.subarray(MAGIC.length + 28)), decipher.final()]);
  } catch {
    throw new Error('Could not decrypt the backup: wrong BACKUP_KEY, or the file was changed or damaged.');
  }
}

const pack = (sql) => seal(zlib.gzipSync(Buffer.from(sql, 'utf8')));
const unpack = (file) => zlib.gunzipSync(unseal(fs.readFileSync(file))).toString('utf8');

module.exports = { loadEnv, sslConfig, connect, listTables, readRows, pack, unpack };
