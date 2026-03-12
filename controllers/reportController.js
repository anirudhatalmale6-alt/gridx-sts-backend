const pool = require('../config/database');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a date-range WHERE clause based on report type.
 * Supports: daily, weekly, monthly, and custom dateFrom/dateTo in query.
 */
function buildDateRange(type, query) {
  const { dateFrom, dateTo } = query;

  if (dateFrom && dateTo) {
    return { clause: 't.created_at >= ? AND t.created_at <= ?', params: [dateFrom, dateTo] };
  }

  const now = new Date();
  let start;

  switch (type) {
    case 'daily':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'weekly':
      start = new Date(now);
      start.setDate(start.getDate() - 7);
      break;
    case 'monthly':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    default:
      // For vendor / revenue / compliance without explicit dates — last 30 days
      start = new Date(now);
      start.setDate(start.getDate() - 30);
      break;
  }

  return { clause: 't.created_at >= ?', params: [start.toISOString().slice(0, 19).replace('T', ' ')] };
}

/**
 * Build a summary KPIs object from aggregated transaction data.
 */
function buildSummary(rows) {
  let totalRevenue = 0;
  let totalTransactions = 0;
  let totalKwh = 0;

  for (const row of rows) {
    totalRevenue += parseFloat(row.grossSales || 0);
    totalTransactions += parseInt(row.transactions || 0, 10);
    totalKwh += parseFloat(row.totalKwh || 0);
  }

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalTransactions,
    totalKwh: Math.round(totalKwh * 100) / 100,
    averageTransaction: totalTransactions > 0
      ? Math.round((totalRevenue / totalTransactions) * 100) / 100
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/reports/:type
 * Generate a report based on type: daily, weekly, monthly, vendor, revenue, compliance.
 */
exports.generate = async (req, res) => {
  try {
    const { type } = req.params;

    const validTypes = ['daily', 'weekly', 'monthly', 'vendor', 'revenue', 'compliance'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid report type. Valid types: ${validTypes.join(', ')}`,
      });
    }

    const { clause, params } = buildDateRange(type, req.query);

    if (type === 'vendor') {
      // Vendor-specific breakdown with commission / VAT calculations
      const [rows] = await pool.query(
        `SELECT
           v.id AS vendorId,
           v.code AS vendorCode,
           v.name AS vendorName,
           v.commission_rate AS commissionRate,
           COUNT(*) AS transactions,
           SUM(t.amount) AS grossSales,
           SUM(t.kwh) AS totalKwh
         FROM transactions t
         LEFT JOIN vendors v ON t.vendor_id = v.id
         WHERE ${clause} AND t.status = 'Success'
         GROUP BY v.id, v.code, v.name, v.commission_rate
         ORDER BY grossSales DESC`,
        params
      );

      // Calculate derived fields per vendor
      const breakdown = rows.map((row) => {
        const gross = parseFloat(row.grossSales || 0);
        const commRate = parseFloat(row.commissionRate || 2) / 100;
        const vatRate = 0.15; // 15% VAT
        const arrearsRate = 0.05; // 5% arrears deduction estimate

        const arrears = Math.round(gross * arrearsRate * 100) / 100;
        const vat = Math.round(gross * vatRate * 100) / 100;
        const commission = Math.round(gross * commRate * 100) / 100;
        const netRevenue = Math.round((gross - arrears - vat - commission) * 100) / 100;

        return {
          vendorId: row.vendorId,
          vendorCode: row.vendorCode,
          vendorName: row.vendorName,
          transactions: parseInt(row.transactions, 10),
          grossSales: Math.round(gross * 100) / 100,
          totalKwh: Math.round(parseFloat(row.totalKwh || 0) * 100) / 100,
          arrears,
          vat,
          commission,
          netRevenue,
        };
      });

      const summary = buildSummary(rows);

      return res.json({ success: true, type, summary, breakdown });
    }

    if (type === 'revenue') {
      // Revenue breakdown grouped by date
      const [rows] = await pool.query(
        `SELECT
           DATE(t.created_at) AS date,
           COUNT(*) AS transactions,
           SUM(t.amount) AS grossSales,
           SUM(t.kwh) AS totalKwh
         FROM transactions t
         WHERE ${clause} AND t.status = 'Success'
         GROUP BY DATE(t.created_at)
         ORDER BY date ASC`,
        params
      );

      const breakdown = rows.map((row) => ({
        date: row.date,
        transactions: parseInt(row.transactions, 10),
        grossSales: Math.round(parseFloat(row.grossSales || 0) * 100) / 100,
        totalKwh: Math.round(parseFloat(row.totalKwh || 0) * 100) / 100,
      }));

      const summary = buildSummary(rows);

      return res.json({ success: true, type, summary, breakdown });
    }

    if (type === 'compliance') {
      // Compliance: reversals, failed transactions, suspicious activity
      const [rows] = await pool.query(
        `SELECT
           t.status,
           COUNT(*) AS count,
           SUM(t.amount) AS totalAmount
         FROM transactions t
         WHERE ${clause}
         GROUP BY t.status
         ORDER BY count DESC`,
        params
      );

      const breakdown = rows.map((row) => ({
        status: row.status,
        count: parseInt(row.count, 10),
        totalAmount: Math.round(parseFloat(row.totalAmount || 0) * 100) / 100,
      }));

      const total = breakdown.reduce((sum, r) => sum + r.count, 0);
      const successCount = breakdown.find((r) => r.status === 'Success')?.count || 0;
      const failedCount = breakdown.find((r) => r.status === 'Failed')?.count || 0;
      const reversalCount = breakdown.find((r) => r.status === 'Reversed')?.count || 0;

      const summary = {
        totalTransactions: total,
        successRate: total > 0 ? Math.round((successCount / total) * 10000) / 100 : 0,
        failedCount,
        reversalCount,
      };

      return res.json({ success: true, type, summary, breakdown });
    }

    // Default: daily / weekly / monthly — aggregated by date
    const [rows] = await pool.query(
      `SELECT
         DATE(t.created_at) AS date,
         COUNT(*) AS transactions,
         SUM(t.amount) AS grossSales,
         SUM(t.kwh) AS totalKwh
       FROM transactions t
       WHERE ${clause} AND t.status = 'Success'
       GROUP BY DATE(t.created_at)
       ORDER BY date ASC`,
      params
    );

    const breakdown = rows.map((row) => ({
      date: row.date,
      transactions: parseInt(row.transactions, 10),
      grossSales: Math.round(parseFloat(row.grossSales || 0) * 100) / 100,
      totalKwh: Math.round(parseFloat(row.totalKwh || 0) * 100) / 100,
    }));

    const summary = buildSummary(rows);

    res.json({ success: true, type, summary, breakdown });
  } catch (err) {
    logger.error('reportController.generate error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to generate report' });
  }
};

/**
 * GET /api/v1/reports/:type/export
 * Export report data as a CSV download.
 */
exports.export = async (req, res) => {
  try {
    const { type } = req.params;

    const validTypes = ['daily', 'weekly', 'monthly', 'vendor', 'revenue', 'compliance'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid report type. Valid types: ${validTypes.join(', ')}`,
      });
    }

    const { clause, params } = buildDateRange(type, req.query);

    let headers;
    let rows;

    if (type === 'vendor') {
      [rows] = await pool.query(
        `SELECT
           v.code AS vendorCode,
           v.name AS vendorName,
           COUNT(*) AS transactions,
           SUM(t.amount) AS grossSales,
           SUM(t.kwh) AS totalKwh,
           v.commission_rate AS commissionRate
         FROM transactions t
         LEFT JOIN vendors v ON t.vendor_id = v.id
         WHERE ${clause} AND t.status = 'Success'
         GROUP BY v.id, v.code, v.name, v.commission_rate
         ORDER BY grossSales DESC`,
        params
      );

      headers = ['Vendor Code', 'Vendor Name', 'Transactions', 'Gross Sales', 'kWh', 'Commission Rate'];
      const csvLines = [headers.join(',')];

      for (const row of rows) {
        csvLines.push([
          row.vendorCode,
          `"${(row.vendorName || '').replace(/"/g, '""')}"`,
          row.transactions,
          row.grossSales,
          row.totalKwh || 0,
          row.commissionRate,
        ].join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=report-${type}.csv`);
      return res.send(csvLines.join('\n'));
    }

    if (type === 'compliance') {
      [rows] = await pool.query(
        `SELECT t.status, COUNT(*) AS count, SUM(t.amount) AS totalAmount
         FROM transactions t
         WHERE ${clause}
         GROUP BY t.status
         ORDER BY count DESC`,
        params
      );

      headers = ['Status', 'Count', 'Total Amount'];
      const csvLines = [headers.join(',')];

      for (const row of rows) {
        csvLines.push([row.status, row.count, row.totalAmount].join(','));
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=report-${type}.csv`);
      return res.send(csvLines.join('\n'));
    }

    // Default: daily / weekly / monthly / revenue — date breakdown
    [rows] = await pool.query(
      `SELECT
         DATE(t.created_at) AS date,
         COUNT(*) AS transactions,
         SUM(t.amount) AS grossSales,
         SUM(t.kwh) AS totalKwh
       FROM transactions t
       WHERE ${clause} AND t.status = 'Success'
       GROUP BY DATE(t.created_at)
       ORDER BY date ASC`,
      params
    );

    headers = ['Date', 'Transactions', 'Gross Sales', 'kWh'];
    const csvLines = [headers.join(',')];

    for (const row of rows) {
      csvLines.push([row.date, row.transactions, row.grossSales, row.totalKwh || 0].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=report-${type}.csv`);
    res.send(csvLines.join('\n'));
  } catch (err) {
    logger.error('reportController.export error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to export report' });
  }
};
