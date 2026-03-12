#!/usr/bin/env node
// ============================================================================
// GRIDx STS — Database Initialization Script
// ============================================================================
// Usage:  node database/init.js
// Or:     npm run db:init
//
// Env vars (via .env or shell):
//   DB_HOST       (default: localhost)
//   DB_PORT       (default: 3306)
//   DB_USER       (default: root)
//   DB_PASSWORD   (default: '')
//   DB_NAME       (default: gridx_sts)
// ============================================================================

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT, 10) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'gridx_sts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a .sql file and split it into individual statements.
 * Strips comments and empty lines, splits on semicolons.
 */
function readSqlFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  // Split on semicolons but keep only non-empty statements.
  // We handle multi-line statements by splitting on ';' at end-of-statement.
  const statements = raw
    .split(/;\s*$/m)             // split on semicolons at end of line
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  return statements;
}

/**
 * Execute an array of SQL statements sequentially.
 */
async function runStatements(connection, statements, label) {
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    // Skip pure comment blocks
    if (/^--/.test(stmt.replace(/\s+/g, ' ').trim())) continue;
    try {
      await connection.query(stmt);
    } catch (err) {
      console.error(`  [ERROR] Statement ${i + 1} in ${label} failed:`);
      console.error(`  ${stmt.substring(0, 120)}...`);
      console.error(`  ${err.message}`);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(60));
  console.log('  GRIDx STS — Database Initialization');
  console.log('='.repeat(60));
  console.log();

  // Step 1 — Connect WITHOUT specifying a database (so we can CREATE it)
  console.log(`[1/5] Connecting to MySQL at ${DB_HOST}:${DB_PORT} as ${DB_USER}...`);
  const rootConnection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
  });
  console.log('  Connected successfully.\n');

  // Step 2 — Create database if it does not exist
  console.log(`[2/5] Creating database "${DB_NAME}" if not exists...`);
  await rootConnection.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await rootConnection.query(`USE \`${DB_NAME}\``);
  console.log(`  Database "${DB_NAME}" ready.\n`);

  // Step 3 — Run schema.sql
  console.log('[3/5] Running schema.sql (DROP + CREATE tables)...');
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}`);
  }
  const schemaStatements = readSqlFile(schemaPath);
  console.log(`  Found ${schemaStatements.length} statements.`);
  await runStatements(rootConnection, schemaStatements, 'schema.sql');
  console.log('  Schema created successfully.\n');

  // Step 4 — Run seed.sql
  console.log('[4/5] Running seed.sql (INSERT demo data)...');
  const seedPath = path.join(__dirname, 'seed.sql');
  if (!fs.existsSync(seedPath)) {
    throw new Error(`seed.sql not found at ${seedPath}`);
  }
  const seedStatements = readSqlFile(seedPath);
  console.log(`  Found ${seedStatements.length} statements.`);
  await runStatements(rootConnection, seedStatements, 'seed.sql');
  console.log('  Seed data inserted successfully.\n');

  // Step 5 — Quick verification
  console.log('[5/5] Verifying table row counts...');
  const tables = [
    'users',
    'customers',
    'transactions',
    'vendors',
    'tariff_groups',
    'tariff_blocks',
    'system_config',
    'audit_log',
  ];

  for (const table of tables) {
    const [rows] = await rootConnection.query(
      `SELECT COUNT(*) AS cnt FROM \`${DB_NAME}\`.\`${table}\``
    );
    console.log(`  ${table.padEnd(20)} ${rows[0].cnt} rows`);
  }

  console.log();
  console.log('='.repeat(60));
  console.log('  Database initialization complete!');
  console.log('='.repeat(60));

  await rootConnection.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[FATAL] Database initialization failed:');
  console.error(err.message);
  process.exit(1);
});
