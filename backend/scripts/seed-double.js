/*
 * Doubles the synthetic data in AlumNet: 50 more HR directory records
 * (25 former and 25 current staff) and up to 25 more mentors, so the mentor
 * pool reaches --target (default 40). Data: database/dataset_extra.json.
 * Every record is synthetic, drafted with AI assistance, and describes no real
 * Kenya Airways staff. Former staff use @example.com addresses, which can
 * never deliver mail.
 *
 *   npm run seed-double                                 preview against backend/.env
 *   npm run seed-double -- --env=.env.live              preview against the live database
 *   npm run seed-double -- --env=.env.live --apply      write the changes
 *   npm run seed-double -- --env=.env.live --undo       remove everything this script added
 *
 * Take a backup first (npm run backup -- --env=.env.live).
 * Seeded mentors cannot sign in: each password is a random value nobody knows.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { loadEnv, sslConfig, connect } = require('./backup-lib');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const UNDO = args.includes('--undo');
const targetArg = args.find((a) => a.startsWith('--target='));
const TARGET = targetArg ? Number(targetArg.slice(9)) : 40;
const PRIVACY_VERSION = require('../src/utils/privacy').PRIVACY_VERSION || null;

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'dataset_extra.json'), 'utf8'));

// The same rule the matching service uses to decide who can be recommended
const ELIGIBLE_SQL = `
  SELECT COUNT(*) AS n FROM mentors mt
  JOIN users u ON u.user_id = mt.user_id
  JOIN profiles p ON p.user_id = mt.user_id
  LEFT JOIN staff_directory sd ON sd.staff_number = u.staff_number
  WHERE u.status = 'active'
    AND (sd.staff_number IS NULL OR (sd.employment_status = 'former' AND sd.alumni_eligible = 1))
    AND CONCAT_WS('', p.skills, p.experience, p.career_interests) <> ''`;

async function counts(db) {
  const [[hr]] = await db.query('SELECT COUNT(*) AS n FROM staff_directory');
  const [[m]] = await db.query(ELIGIBLE_SQL);
  return { hr: Number(hr.n), mentors: Number(m.n) };
}

async function main() {
  const envFile = loadEnv();
  const db = await connect({
    host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, ssl: sslConfig()
  });
  try {
    console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST} (settings from ${path.basename(envFile)})`);
    const before = await counts(db);
    console.log(`Now: ${before.hr} HR records, ${before.mentors} mentors who can be recommended`);
    const staff = DATA.hr.map((r) => r.staff_number);

    if (UNDO) {
      const [rows] = await db.query('SELECT user_id FROM users WHERE staff_number IN (?) AND email LIKE ?', [staff, '%@example.com']);
      console.log(`Would remove ${rows.length} seeded mentor accounts and the ${staff.length} seeded HR records.`);
      if (!APPLY && !args.includes('--yes')) { console.log('Add --yes to remove them.'); return; }
      await db.beginTransaction();
      if (rows.length) await db.query('DELETE FROM users WHERE user_id IN (?)', [rows.map((r) => r.user_id)]);
      await db.query('DELETE FROM staff_directory WHERE staff_number IN (?)', [staff]);
      await db.commit();
      const after = await counts(db);
      console.log(`Removed. Now: ${after.hr} HR records, ${after.mentors} mentors.`);
      return;
    }

    // Refuse to run if any synthetic number or email clashes with an existing record
    const [clashHr] = await db.query('SELECT staff_number FROM staff_directory WHERE staff_number IN (?) OR id_number IN (?)',
      [staff, DATA.hr.map((r) => r.id_number)]);
    const [clashUsers] = await db.query('SELECT email FROM users WHERE staff_number IN (?) OR email IN (?)',
      [staff, DATA.mentors.map((m) => m.email)]);
    if (clashHr.length || clashUsers.length) {
      console.log(`Already present or clashing: ${clashHr.length} HR records, ${clashUsers.length} accounts. Nothing written.`);
      console.log('If this script ran before, use --undo first.');
      return;
    }

    const toAdd = DATA.mentors.slice(0, Math.max(0, Math.min(DATA.mentors.length, TARGET - before.mentors)));
    console.log(`Plan: add ${DATA.hr.length} HR records and ${toAdd.length} mentors (target ${TARGET}).`);
    if (!APPLY) { console.log('Preview only. Add --apply to write.'); return; }

    await db.beginTransaction();
    for (const r of DATA.hr) {
      await db.query(
        `INSERT INTO staff_directory (staff_number, id_number, full_name, department, mobile_number, kq_email, personal_email, employment_status, alumni_eligible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [r.staff_number, r.id_number, r.full_name, r.department, r.mobile_number, r.kq_email, r.personal_email, r.employment_status]);
    }
    for (const m of toAdd) {
      const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      const [res] = await db.query(
        `INSERT INTO users (name, email, password_hash, staff_number, department, country, city, status,
                            email_verified_at, privacy_accepted_at, privacy_version, onboarded_at)
         VALUES (?, ?, ?, ?, ?, 'Kenya', 'Nairobi', 'active', NOW(), NOW(), ?, NOW())`,
        [m.name, m.email, hash, m.staff_number, m.department, PRIVACY_VERSION]);
      const id = res.insertId;
      await db.query('INSERT INTO mentors (user_id, years_of_experience, accepting_mentees, max_mentees, meeting_mode) VALUES (?, ?, 1, 3, ?)',
        [id, m.years_of_experience, m.meeting_mode]);
      await db.query('INSERT INTO profiles (user_id, skills, experience, career_interests, industry, headline) VALUES (?, ?, ?, ?, ?, ?)',
        [id, m.skills, m.experience, m.career_interests, m.industry, m.headline]);
    }
    await db.commit();
    const after = await counts(db);
    console.log(`Done. Now: ${after.hr} HR records, ${after.mentors} mentors who can be recommended.`);
    console.log('Open Find a mentor once before timing, so the new mentor vectors are computed and cached.');
  } catch (err) {
    try { await db.rollback(); } catch (_) { /* nothing to undo */ }
    console.error('Stopped, nothing was changed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main();
