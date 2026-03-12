const pool = require('../config/database');
const logger = require('../config/logger');

// ===========================================================================
// POST /sales
// Open a new sales batch for a vendor
// ===========================================================================
exports.openSalesBatch = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { vendorId, notes } = req.body;

    if (!vendorId) {
      return res.status(400).json({
        success: false,
        message: 'vendorId is required.',
      });
    }

    // Verify vendor exists
    const [vendors] = await conn.query(
      'SELECT id, code, name FROM vendors WHERE id = ?',
      [vendorId]
    );

    if (vendors.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found.',
      });
    }

    const vendor = vendors[0];

    // Generate batch number: SB-YYYYMMDD-{seq}
    const today = new Date();
    const dateStr =
      today.getFullYear().toString() +
      String(today.getMonth() + 1).padStart(2, '0') +
      String(today.getDate()).padStart(2, '0');

    // Get the next sequence number for today
    const [seqRows] = await conn.query(
      "SELECT COUNT(*) as cnt FROM sales_batches WHERE batch_number LIKE ?",
      [`SB-${dateStr}-%`]
    );
    const seq = (seqRows[0].cnt || 0) + 1;
    const batchNumber = `SB-${dateStr}-${String(seq).padStart(3, '0')}`;

    await conn.beginTransaction();

    try {
      const [result] = await conn.query(
        `INSERT INTO sales_batches (batch_number, vendor_id, status, notes, opened_by, opened_at)
         VALUES (?, ?, 'Open', ?, ?, NOW())`,
        [batchNumber, vendorId, notes || null, req.user ? req.user.id : null]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'batch', ?)`,
        [
          'SALES_BATCH_OPENED',
          JSON.stringify({
            batchId: result.insertId,
            batchNumber,
            vendorId,
            vendorName: vendor.name,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Sales batch opened: ${batchNumber} | Vendor: ${vendor.name}`, {
        batchId: result.insertId,
        batchNumber,
        vendorId,
      });

      return res.status(201).json({
        success: true,
        batchId: result.insertId,
        batchNumber,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('openSalesBatch failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to open sales batch.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// PUT /sales/:id/close
// Close a sales batch, calculating totals from linked transactions
// ===========================================================================
exports.closeSalesBatch = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;

    // Find the batch
    const [batches] = await conn.query(
      'SELECT * FROM sales_batches WHERE id = ?',
      [id]
    );

    if (batches.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sales batch not found.',
      });
    }

    const batch = batches[0];

    if (batch.status === 'Closed') {
      return res.status(400).json({
        success: false,
        message: 'This sales batch is already closed.',
      });
    }

    // Calculate totals from transactions linked to this batch
    const [summary] = await conn.query(
      `SELECT
         COALESCE(SUM(amount), 0) AS total_amount,
         COUNT(*) AS total_transactions
       FROM transactions
       WHERE batch_id = ? AND status = 'Success'`,
      [id]
    );

    const totalAmount = parseFloat(summary[0].total_amount) || 0;
    const totalTransactions = summary[0].total_transactions || 0;

    await conn.beginTransaction();

    try {
      await conn.query(
        `UPDATE sales_batches
         SET status = 'Closed',
             total_amount = ?,
             total_transactions = ?,
             closed_at = NOW(),
             closed_by = ?
         WHERE id = ?`,
        [totalAmount, totalTransactions, req.user ? req.user.id : null, id]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'batch', ?)`,
        [
          'SALES_BATCH_CLOSED',
          JSON.stringify({
            batchId: id,
            batchNumber: batch.batch_number,
            totalAmount,
            totalTransactions,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Sales batch closed: ${batch.batch_number} | Total: ${totalAmount} | Txns: ${totalTransactions}`, {
        batchId: id,
        totalAmount,
        totalTransactions,
      });

      return res.json({
        success: true,
        summary: {
          batchId: parseInt(id, 10),
          batchNumber: batch.batch_number,
          totalAmount,
          totalTransactions,
          closedAt: new Date().toISOString(),
        },
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('closeSalesBatch failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to close sales batch.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// GET /sales
// List sales batches with filters and pagination
// ===========================================================================
exports.getSalesBatches = async (req, res) => {
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
      whereClause += ' AND sb.vendor_id = ?';
      params.push(vendorId);
    }
    if (status) {
      whereClause += ' AND sb.status = ?';
      params.push(status);
    }
    if (dateFrom) {
      whereClause += ' AND sb.opened_at >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClause += ' AND sb.opened_at <= ?';
      params.push(dateTo);
    }

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM sales_batches sb
       ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    // Data query with vendor name
    const [rows] = await pool.query(
      `SELECT sb.*, v.name AS vendor_name
       FROM sales_batches sb
       LEFT JOIN vendors v ON v.id = sb.vendor_id
       ${whereClause}
       ORDER BY sb.opened_at DESC
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
    logger.error('getSalesBatches failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch sales batches.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// GET /sales/:id
// Get a single sales batch with all its transactions
// ===========================================================================
exports.getSalesBatchDetail = async (req, res) => {
  try {
    const { id } = req.params;

    // Get batch info with vendor name
    const [batches] = await pool.query(
      `SELECT sb.*, v.name AS vendor_name
       FROM sales_batches sb
       LEFT JOIN vendors v ON v.id = sb.vendor_id
       WHERE sb.id = ?`,
      [id]
    );

    if (batches.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sales batch not found.',
      });
    }

    // Get all transactions for this batch
    const [transactions] = await pool.query(
      `SELECT t.*, c.name AS customer_name
       FROM transactions t
       LEFT JOIN customers c ON c.id = t.customer_id
       WHERE t.batch_id = ?
       ORDER BY t.created_at DESC`,
      [id]
    );

    return res.json({
      success: true,
      data: {
        ...batches[0],
        transactions,
      },
    });
  } catch (err) {
    logger.error('getSalesBatchDetail failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch sales batch detail.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// POST /banking
// Open a new banking batch linked to a sales batch
// ===========================================================================
exports.openBankingBatch = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { salesBatchId, bankReference } = req.body;

    if (!salesBatchId) {
      return res.status(400).json({
        success: false,
        message: 'salesBatchId is required.',
      });
    }

    // Verify sales batch exists and is closed
    const [salesBatches] = await conn.query(
      'SELECT * FROM sales_batches WHERE id = ?',
      [salesBatchId]
    );

    if (salesBatches.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sales batch not found.',
      });
    }

    const salesBatch = salesBatches[0];

    if (salesBatch.status !== 'Closed') {
      return res.status(400).json({
        success: false,
        message: 'Sales batch must be closed before creating a banking batch.',
      });
    }

    await conn.beginTransaction();

    try {
      const [result] = await conn.query(
        `INSERT INTO banking_batches (sales_batch_id, bank_reference, status, amount, created_by, created_at)
         VALUES (?, ?, 'Pending', ?, ?, NOW())`,
        [
          salesBatchId,
          bankReference || null,
          salesBatch.total_amount || 0,
          req.user ? req.user.id : null,
        ]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'batch', ?)`,
        [
          'BANKING_BATCH_OPENED',
          JSON.stringify({
            bankingBatchId: result.insertId,
            salesBatchId,
            salesBatchNumber: salesBatch.batch_number,
            bankReference: bankReference || null,
            amount: salesBatch.total_amount,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Banking batch opened: id=${result.insertId} | Sales batch: ${salesBatch.batch_number}`, {
        bankingBatchId: result.insertId,
        salesBatchId,
      });

      return res.status(201).json({
        success: true,
        batchId: result.insertId,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('openBankingBatch failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to open banking batch.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// PUT /banking/:id
// Close/update banking batch status (Submitted or Cleared)
// ===========================================================================
exports.closeBankingBatch = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['Submitted', 'Cleared'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status is required and must be one of: ${validStatuses.join(', ')}`,
      });
    }

    // Find the banking batch
    const [batches] = await conn.query(
      'SELECT * FROM banking_batches WHERE id = ?',
      [id]
    );

    if (batches.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Banking batch not found.',
      });
    }

    const batch = batches[0];

    await conn.beginTransaction();

    try {
      const updateFields = { status };
      if (status === 'Submitted') {
        updateFields.submitted_at = new Date();
      } else if (status === 'Cleared') {
        updateFields.cleared_at = new Date();
      }

      await conn.query(
        `UPDATE banking_batches
         SET status = ?,
             submitted_at = COALESCE(?, submitted_at),
             cleared_at = COALESCE(?, cleared_at),
             updated_by = ?
         WHERE id = ?`,
        [
          status,
          status === 'Submitted' ? new Date() : null,
          status === 'Cleared' ? new Date() : null,
          req.user ? req.user.id : null,
          id,
        ]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'batch', ?)`,
        [
          `BANKING_BATCH_${status.toUpperCase()}`,
          JSON.stringify({
            bankingBatchId: id,
            salesBatchId: batch.sales_batch_id,
            status,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Banking batch ${status}: id=${id}`, {
        bankingBatchId: id,
        status,
      });

      return res.json({
        success: true,
        message: `Banking batch marked as ${status}.`,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('closeBankingBatch failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to update banking batch.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// GET /banking
// List banking batches with filters and pagination
// ===========================================================================
exports.getBankingBatches = async (req, res) => {
  try {
    const {
      salesBatchId,
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

    if (salesBatchId) {
      whereClause += ' AND bb.sales_batch_id = ?';
      params.push(salesBatchId);
    }
    if (status) {
      whereClause += ' AND bb.status = ?';
      params.push(status);
    }
    if (dateFrom) {
      whereClause += ' AND bb.created_at >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClause += ' AND bb.created_at <= ?';
      params.push(dateTo);
    }

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM banking_batches bb
       ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    // Data query
    const [rows] = await pool.query(
      `SELECT bb.*, sb.batch_number AS sales_batch_number, v.name AS vendor_name
       FROM banking_batches bb
       LEFT JOIN sales_batches sb ON sb.id = bb.sales_batch_id
       LEFT JOIN vendors v ON v.id = sb.vendor_id
       ${whereClause}
       ORDER BY bb.created_at DESC
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
    logger.error('getBankingBatches failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch banking batches.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// PUT /sales/:id/reconcile
// Mark a sales batch as Reconciled after its banking batch clears
// ===========================================================================
exports.reconcileBatch = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;

    // Find the sales batch
    const [batches] = await conn.query(
      'SELECT * FROM sales_batches WHERE id = ?',
      [id]
    );

    if (batches.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sales batch not found.',
      });
    }

    const batch = batches[0];

    if (batch.status !== 'Closed') {
      return res.status(400).json({
        success: false,
        message: 'Sales batch must be in Closed status to reconcile.',
      });
    }

    // Check if there is a cleared banking batch linked
    const [bankingBatches] = await conn.query(
      "SELECT * FROM banking_batches WHERE sales_batch_id = ? AND status = 'Cleared' LIMIT 1",
      [id]
    );

    if (bankingBatches.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No cleared banking batch found for this sales batch. Banking must clear before reconciliation.',
      });
    }

    await conn.beginTransaction();

    try {
      await conn.query(
        `UPDATE sales_batches
         SET status = 'Reconciled',
             reconciled_at = NOW(),
             reconciled_by = ?
         WHERE id = ?`,
        [req.user ? req.user.id : null, id]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'batch', ?)`,
        [
          'SALES_BATCH_RECONCILED',
          JSON.stringify({
            batchId: id,
            batchNumber: batch.batch_number,
            totalAmount: batch.total_amount,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Sales batch reconciled: ${batch.batch_number}`, {
        batchId: id,
        batchNumber: batch.batch_number,
      });

      return res.json({
        success: true,
        message: `Sales batch ${batch.batch_number} has been reconciled.`,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('reconcileBatch failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to reconcile batch.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};
