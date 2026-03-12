const pool = require('../config/database');
const logger = require('../config/logger');

/**
 * GET /api/v1/transactions
 * List transactions with optional filters and pagination.
 */
exports.getAll = async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      type,
      status,
      meterNo,
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (dateFrom) {
      whereClause += ' AND t.created_at >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClause += ' AND t.created_at <= ?';
      params.push(dateTo);
    }
    if (type) {
      whereClause += ' AND t.type = ?';
      params.push(type);
    }
    if (status) {
      whereClause += ' AND t.status = ?';
      params.push(status);
    }
    if (meterNo) {
      whereClause += ' AND t.meter_no = ?';
      params.push(meterNo);
    }

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total
       FROM transactions t
       LEFT JOIN customers c ON t.customer_id = c.id
       ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    // Data query
    const [rows] = await pool.query(
      `SELECT t.*, c.name AS customer
       FROM transactions t
       LEFT JOIN customers c ON t.customer_id = c.id
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({
      success: true,
      data: rows,
      total,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    logger.error('transactionController.getAll error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
};

/**
 * GET /api/v1/transactions/:id
 * Retrieve a single transaction by id or reference.
 */
exports.getById = async (req, res) => {
  try {
    const { id } = req.params;

    // Allow lookup by numeric id or by reference string
    const isNumeric = /^\d+$/.test(id);
    const [rows] = await pool.query(
      `SELECT t.*, c.name AS customer
       FROM transactions t
       LEFT JOIN customers c ON t.customer_id = c.id
       WHERE ${isNumeric ? 't.id = ?' : 't.reference = ?'}`,
      [isNumeric ? parseInt(id, 10) : id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    logger.error('transactionController.getById error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch transaction' });
  }
};

/**
 * GET /api/v1/transactions/export?format=csv
 * Export filtered transactions as a CSV download.
 */
exports.export = async (req, res) => {
  try {
    const { dateFrom, dateTo, type, status, meterNo, format } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (dateFrom) {
      whereClause += ' AND t.created_at >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClause += ' AND t.created_at <= ?';
      params.push(dateTo);
    }
    if (type) {
      whereClause += ' AND t.type = ?';
      params.push(type);
    }
    if (status) {
      whereClause += ' AND t.status = ?';
      params.push(status);
    }
    if (meterNo) {
      whereClause += ' AND t.meter_no = ?';
      params.push(meterNo);
    }

    const [rows] = await pool.query(
      `SELECT t.reference, t.meter_no, c.name AS customer, t.amount, t.kwh,
              t.token, t.type, t.status, t.created_at
       FROM transactions t
       LEFT JOIN customers c ON t.customer_id = c.id
       ${whereClause}
       ORDER BY t.created_at DESC`,
      params
    );

    if (format === 'csv') {
      const headers = ['Reference', 'Meter No', 'Customer', 'Amount', 'kWh', 'Token', 'Type', 'Status', 'Date'];
      const csvLines = [headers.join(',')];

      for (const row of rows) {
        csvLines.push([
          row.reference,
          row.meter_no,
          `"${(row.customer || '').replace(/"/g, '""')}"`,
          row.amount,
          row.kwh || '',
          row.token || '',
          row.type,
          row.status,
          row.created_at,
        ].join(','));
      }

      const csv = csvLines.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
      return res.send(csv);
    }

    // Default: return JSON
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('transactionController.export error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to export transactions' });
  }
};
