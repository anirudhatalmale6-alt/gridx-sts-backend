const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

/**
 * Parse RDS_HOSTNAME to extract just the IP address.
 * Expected format: user@ip:port  — we extract only the IP portion.
 * If the value is already a plain IP/hostname, it is used as-is.
 */
function parseHost(raw) {
  if (!raw) return 'localhost';

  let host = raw;

  // Strip user@ prefix if present (e.g. "admin@10.0.0.1:3306")
  if (host.includes('@')) {
    host = host.split('@').pop();
  }

  // Strip :port suffix if present (e.g. "10.0.0.1:3306")
  if (host.includes(':')) {
    host = host.split(':')[0];
  }

  return host;
}

const pool = mysql.createPool({
  host: parseHost(process.env.RDS_HOSTNAME),
  user: process.env.RDS_USERNAME || 'root',
  password: process.env.RDS_PASSWORD || '',
  port: parseInt(process.env.RDS_PORT, 10) || 3306,
  database: process.env.RDS_DB_NAME || 'gridx_sts',
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  decimalNumbers: true,
});

// Test connection on first import
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log(`[database] Connected to MySQL at ${parseHost(process.env.RDS_HOSTNAME)}:${process.env.RDS_PORT || 3306} — database: ${process.env.RDS_DB_NAME || 'gridx_sts'}`);
    connection.release();
  } catch (err) {
    console.error('[database] Failed to connect to MySQL:', err.message);
  }
})();

module.exports = pool;
