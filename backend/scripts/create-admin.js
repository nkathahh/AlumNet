require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/config/db');

async function main() {
    const [name, email, password] = process.argv.slice(2);
    if (!name || !email || !password) {
        console.log('Usage: node scripts/create-admin.js "Full Name" email@example.com password');
        process.exit(1);
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
        `INSERT INTO users (name, email, password_hash, id_number, country, city, status)
     VALUES (:name, :email, :passwordHash, :idNumber, 'Kenya', 'Nairobi', 'active')`,
        { name, email, passwordHash, idNumber: `ADMIN-${Date.now()}` }
    );
    await pool.execute('INSERT INTO admins (user_id, admin_level) VALUES (:userId, "super")', { userId: result.insertId });
    console.log(`Admin created: user_id ${result.insertId}`);
    process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });