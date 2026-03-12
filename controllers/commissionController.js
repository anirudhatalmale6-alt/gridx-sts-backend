const pool = require('../config/database');
const logger = require('../config/logger');

// ===========================================================================
// POST /calculate
// Calculate commissions for a vendor over a date range
// ===========================================================================
exports.calculateCommissions = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { vendorId, dateFrom, dateTo } = req.body;

    if (!vendorId || !dateFrom || !dateTo) {
      return res.status(400).json({
        success: false,
        message: 'vendorId, dateFrom, and dateTo are required.',
      });
    }

    // Verify vendor exists and get commission rate
    const [vendors] = await conn.query(
      'SELECT id, code, name, commission_rate FROM vendors WHERE id = ?',
      [vendorId]
    );

    if (vendors.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found.',
      });
    }

    const vendor = vendors[0];
    const commissionRate = parseFloat(vendor.commission_rate) || 0;

    if (commissionRate <= 0) {
      return res.status(400).json({
        success: false,
        message: `Vendor "${vendor.name}" has no commission rate configured.`,
      });
    }

    // Query all successful transactions for the vendor in the date range
    const [transactions] = await conn.query(
      `SELECT id, reference, amount, created_at
       FROM transactions
       WHERE vendor_id = ?
         AND status = 'Success'
         AND created_at >= ?
         AND created_at <= ?
       ORDER BY created_at ASC`,
      [vendorId, dateFrom, dateTo]
    );

    if (transactions.length === 0) {
      return res.json({
        success: true,
        totalCommission: 0,
        recordCount: 0,
        message: 'No transactions found in the specified date range.',
      });
    }

    await conn.beginTransaction();

    try {
      let totalCommission = 0;
      let recordCount = 0;

      for (const txn of transactions) {
        const amount = parseFloat(txn.amount) || 0;
        const commission = Math.round((amount * commissionRate / 100) * 100) / 100;

        if (commission > 0) {
          await conn.query(
            `INSERT INTO commission_records
               (vendor_id, transaction_id, transaction_reference, amount, commission_rate, commission_amount, status, period_from, period_to, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, NOW())`,
            [
              vendorId,
              txn.id,
              txn.reference,
              amount,
              commissionRate,
              commission,
              dateFrom,
              dateTo,
              req.user ? req.user.id : null,
            ]
          );

          totalCommission += commission;
          recordCount++;
        }
      }

      totalCommission = Math.round(totalCommission * 100) / 100;

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'commission', ?)`,
        [
          'COMMISSIONS_CALCULATED',
          JSON.stringify({
            vendorId,
            vendorName: vendor.name,
            dateFrom,
            dateTo,
            commissionRate,
            totalCommission,
            recordCount,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Commissions calculated: Vendor ${vendor.name} | Total: ${totalCommission} | Records: ${recordCount}`, {
        vendorId,
        totalCommission,
        recordCount,
      });

      return res.status(201).json({
        success: true,
        totalCommission,
        recordCount,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('calculateCommissions failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to calculate commissions.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// GET /
// List commission records with filters and pagination
// ===========================================================================
exports.getCommissions = async (req, res) => {
  try {
    const {
      vendorId,
      status,
      dateFrom,
      dateTo,
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (vendorId) {
      whereClause += ' AND cr.vendor_id = ?';
      params.push(vendorId);
    }
    if (status) {
      whereClause += ' AND cr.status = ?';
      params.push(status);
    }
    if (dateFrom) {
      whereClause += ' AND cr.created_at >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClause += ' AND cr.created_at <= ?';
      params.push(dateTo);
    }

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM commission_records cr
       ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    // Data query
    const [rows] = await pool.query(
      `SELECT cr.*, v.name AS vendor_name, v.code AS vendor_code
       FROM commission_records cr
       LEFT JOIN vendors v ON v.id = cr.vendor_id
       ${whereClause}
       ORDER BY cr.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    return res.json({
      success: true,
      data: rows,
      total,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    logger.error('getCommissions failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch commissions.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// PUT /:id/approve
// Approve a commission record (ADMIN only)
// ===========================================================================
exports.approveCommission = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;

    // Find the commission record
    const [records] = await conn.query(
      'SELECT * FROM commission_records WHERE id = ?',
      [id]
    );

    if (records.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Commission record not found.',
      });
    }

    const record = records[0];

    if (record.status !== 'Pending') {
      return res.status(400).json({
        success: false,
        message: `Commission record is already in "${record.status}" status. Only Pending records can be approved.`,
      });
    }

    await conn.beginTransaction();

    try {
      await conn.query(
        `UPDATE commission_records
         SET status = 'Approved',
             approved_by = ?,
             approved_at = NOW()
         WHERE id = ?`,
        [req.user ? req.user.id : null, id]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'commission', ?)`,
        [
          'COMMISSION_APPROVED',
          JSON.stringify({
            commissionId: id,
            vendorId: record.vendor_id,
            commissionAmount: record.commission_amount,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Commission approved: id=${id} | Amount: ${record.commission_amount}`, {
        commissionId: id,
      });

      return res.json({
        success: true,
        message: 'Commission record approved.',
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('approveCommission failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to approve commission.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// PUT /:id/paid
// Mark a commission record as Paid (ADMIN only)
// ===========================================================================
exports.markCommissionPaid = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;

    // Find the commission record
    const [records] = await conn.query(
      'SELECT * FROM commission_records WHERE id = ?',
      [id]
    );

    if (records.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Commission record not found.',
      });
    }

    const record = records[0];

    if (record.status !== 'Approved') {
      return res.status(400).json({
        success: false,
        message: `Commission record is in "${record.status}" status. Only Approved records can be marked as Paid.`,
      });
    }

    await conn.beginTransaction();

    try {
      await conn.query(
        `UPDATE commission_records
         SET status = 'Paid',
             paid_at = NOW(),
             paid_by = ?
         WHERE id = ?`,
        [req.user ? req.user.id : null, id]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'commission', ?)`,
        [
          'COMMISSION_PAID',
          JSON.stringify({
            commissionId: id,
            vendorId: record.vendor_id,
            commissionAmount: record.commission_amount,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Commission paid: id=${id} | Amount: ${record.commission_amount}`, {
        commissionId: id,
      });

      return res.json({
        success: true,
        message: 'Commission record marked as paid.',
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('markCommissionPaid failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to mark commission as paid.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// GET /summary
// Aggregate commission summary by vendor
// ===========================================================================
exports.getCommissionSummary = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         v.id AS vendor_id,
         v.code AS vendor_code,
         v.name AS vendor_name,
         v.commission_rate,
         COALESCE(SUM(CASE WHEN cr.status = 'Pending'  THEN cr.commission_amount ELSE 0 END), 0) AS total_pending,
         COALESCE(SUM(CASE WHEN cr.status = 'Approved' THEN cr.commission_amount ELSE 0 END), 0) AS total_approved,
         COALESCE(SUM(CASE WHEN cr.status = 'Paid'     THEN cr.commission_amount ELSE 0 END), 0) AS total_paid,
         COUNT(cr.id) AS total_records
       FROM vendors v
       LEFT JOIN commission_records cr ON cr.vendor_id = v.id
       GROUP BY v.id, v.code, v.name, v.commission_rate
       ORDER BY v.name ASC`
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    logger.error('getCommissionSummary failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch commission summary.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};
