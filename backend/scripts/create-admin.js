require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/config/db');

// Creates an admin account. Admins must turn on two-factor authentication
// in Account settings before the admin tools will open.
async function main() {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.log('Usage: node scripts/create-admin.js "Full Name" email@example.com password');
    process.exit(1);
  }
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    console.log('Password must be at least 8 characters, with letters and numbers.');
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await pool.execute(
    `INSERT INTO users (name, email, password_hash, country, city, status, email_verified_at, onboarded_at, privacy_accepted_at)
     VALUES (:name, :email, :passwordHash, 'Kenya', 'Nairobi', 'active', NOW(), NOW(), NOW())`,
    { name, email: email.trim().toLowerCase(), passwordHash }
  );
  await pool.execute('INSERT INTO admins (user_id, admin_level) VALUES (:userId, "super")', { userId: result.insertId });
  console.log(`Admin created: user_id ${result.insertId}. Log in, then turn on two-factor in Account settings.`);
  process.exit(0);
}
main().catch((err) => { console.error(err.message); process.exit(1); });
