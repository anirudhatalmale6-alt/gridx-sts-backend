const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const logger = require('../config/logger');

const BACKUP_DIR = '/backups';

// ---------------------------------------------------------------------------
// Helper — ensure the backup directory exists
// ---------------------------------------------------------------------------
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logger.info(`Backup directory created: ${BACKUP_DIR}`);
  }
}

// ===========================================================================
// runBackup — Perform a mysqldump and compress with gzip
// ===========================================================================
async function runBackup() {
  const conn = await pool.getConnection();
  try {
    ensureBackupDir();

    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const timestamp =
      now.getFullYear().toString() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) + '_' +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());

    const dbName = process.env.RDS_DB_NAME || 'gridx_sts';
    const dbHost = process.env.RDS_HOSTNAME || 'localhost';
    const dbUser = process.env.RDS_USERNAME || 'root';
    const dbPass = process.env.RDS_PASSWORD || '';
    const dbPort = process.env.RDS_PORT || '3306';

    const filename = `gridx_sts_${timestamp}.sql.gz`;
    const filePath = path.join(BACKUP_DIR, filename);

    // Build mysqldump command
    let dumpCmd = `mysqldump -h "${dbHost}" -P ${dbPort} -u "${dbUser}"`;
    if (dbPass) {
      dumpCmd += ` -p"${dbPass}"`;
    }
    dumpCmd += ` "${dbName}" | gzip > "${filePath}"`;

    logger.info('Starting database backup', { filename, dbName });

    execSync(dumpCmd, {
      stdio: 'pipe',
      shell: '/bin/bash',
      timeout: 300000, // 5 minute timeout
    });

    // Verify the backup file exists and has content
    const stats = fs.statSync(filePath);

    logger.info('Database backup completed', {
      filename,
      sizeBytes: stats.size,
      path: filePath,
    });

    // Update system_config with last backup info
    await conn.query(
      `INSERT INTO system_config (config_key, config_value)
       VALUES ('lastBackup', ?)
       ON DUPLICATE KEY UPDATE config_value = ?`,
      [now.toISOString(), now.toISOString()]
    );

    await conn.query(
      `INSERT INTO system_config (config_key, config_value)
       VALUES ('lastBackupFile', ?)
       ON DUPLICATE KEY UPDATE config_value = ?`,
      [filename, filename]
    );

    // Audit log entry
    await conn.query(
      `INSERT INTO audit_log (event, detail, username, type, ip_address)
       VALUES (?, ?, 'system', 'backup', NULL)`,
      [
        'DATABASE_BACKUP',
        JSON.stringify({ filename, sizeBytes: stats.size }),
      ]
    );

    return {
      success: true,
      filename,
      path: filePath,
      sizeBytes: stats.size,
      timestamp: now.toISOString(),
    };
  } catch (err) {
    logger.error('Database backup failed', { error: err.message, stack: err.stack });

    // Attempt audit log even on failure
    try {
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, 'system', 'backup', NULL)`,
        [
          'DATABASE_BACKUP_FAILED',
          JSON.stringify({ error: err.message }),
        ]
      );
    } catch (logErr) {
      logger.error('Failed to log backup failure to audit', { error: logErr.message });
    }

    throw err;
  } finally {
    conn.release();
  }
}

// ===========================================================================
// archiveOldTransactions — Move old transactions to transaction_archive
// ===========================================================================
async function archiveOldTransactions(daysOld = 365) {
  const conn = await pool.getConnection();
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    const cutoffStr = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

    logger.info('Archiving old transactions', { daysOld, cutoffDate: cutoffStr });

    await conn.beginTransaction();

    try {
      // Copy old transactions to archive table
      const [insertResult] = await conn.query(
        `INSERT INTO transaction_archive
         SELECT * FROM transactions
         WHERE created_at < ?`,
        [cutoffStr]
      );

      const archivedCount = insertResult.affectedRows;

      if (archivedCount > 0) {
        // Delete the archived transactions from the main table
        await conn.query(
          'DELETE FROM transactions WHERE created_at < ?',
          [cutoffStr]
        );
      }

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, 'system', 'archive', NULL)`,
        [
          'TRANSACTIONS_ARCHIVED',
          JSON.stringify({ daysOld, cutoffDate: cutoffStr, archivedCount }),
        ]
      );

      await conn.commit();

      logger.info('Transaction archiving completed', { archivedCount, cutoffDate: cutoffStr });

      return {
        success: true,
        archivedCount,
        cutoffDate: cutoffStr,
      };
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('archiveOldTransactions failed', { error: err.message, stack: err.stack });
    throw err;
  } finally {
    conn.release();
  }
}

// ===========================================================================
// cleanOldBackups — Remove backup files older than retentionDays
// ===========================================================================
function cleanOldBackups(retentionDays = 30) {
  try {
    ensureBackupDir();

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(BACKUP_DIR);
    let removedCount = 0;
    let freedBytes = 0;

    for (const file of files) {
      // Only clean files matching our naming pattern
      if (!file.startsWith('gridx_sts_') || !file.endsWith('.sql.gz')) {
        continue;
      }

      const filePath = path.join(BACKUP_DIR, file);
      const stats = fs.statSync(filePath);

      if (stats.mtimeMs < cutoff) {
        freedBytes += stats.size;
        fs.unlinkSync(filePath);
        removedCount++;
        logger.info('Removed old backup file', { file, ageMs: Date.now() - stats.mtimeMs });
      }
    }

    logger.info('Old backup cleanup completed', { removedCount, freedBytes, retentionDays });

    return {
      success: true,
      removedCount,
      freedBytes,
      retentionDays,
    };
  } catch (err) {
    logger.error('cleanOldBackups failed', { error: err.message, stack: err.stack });
    throw err;
  }
}

// ===========================================================================
// getBackupStatus — Return current backup status and stats
// ===========================================================================
async function getBackupStatus() {
  const conn = await pool.getConnection();
  try {
    // Get last backup time from system_config
    const [configRows] = await conn.query(
      "SELECT config_key, config_value FROM system_config WHERE config_key IN ('lastBackup', 'lastBackupFile')"
    );

    const config = {};
    for (const row of configRows) {
      config[row.config_key] = row.config_value;
    }

    // Count backup files and total size
    let fileCount = 0;
    let totalSizeBytes = 0;
    const backupFiles = [];

    if (fs.existsSync(BACKUP_DIR)) {
      const files = fs.readdirSync(BACKUP_DIR);

      for (const file of files) {
        if (!file.startsWith('gridx_sts_') || !file.endsWith('.sql.gz')) {
          continue;
        }

        const filePath = path.join(BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        fileCount++;
        totalSizeBytes += stats.size;
        backupFiles.push({
          name: file,
          sizeBytes: stats.size,
          createdAt: stats.mtime.toISOString(),
        });
      }

      // Sort by date descending
      backupFiles.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    // Get archive stats
    let archiveCount = 0;
    try {
      const [archiveRows] = await conn.query(
        'SELECT COUNT(*) AS total FROM transaction_archive'
      );
      archiveCount = archiveRows[0].total;
    } catch {
      // transaction_archive table may not exist yet
    }

    return {
      lastBackup: config.lastBackup || null,
      lastBackupFile: config.lastBackupFile || null,
      fileCount,
      totalSizeBytes,
      totalSizeMB: Math.round((totalSizeBytes / (1024 * 1024)) * 100) / 100,
      archivedTransactions: archiveCount,
      recentBackups: backupFiles.slice(0, 10),
    };
  } catch (err) {
    logger.error('getBackupStatus failed', { error: err.message, stack: err.stack });
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  runBackup,
  archiveOldTransactions,
  cleanOldBackups,
  getBackupStatus,
};
