const mysql = require('mysql2/promise');
require('dotenv').config();

// Hosted MySQL (for example Aiven) requires an encrypted connection.
// Set DB_SSL=true, and optionally DB_SSL_CA to the provider's CA certificate
// (the full PEM text) so the server's identity is checked.
function sslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  if (process.env.DB_SSL_CA) {
    return { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: sslConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true
});

module.exports = pool;
