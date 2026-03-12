const pool = require('../config/database');
const logger = require('../config/logger');

/**
 * GET /api/v1/dashboard/kpis
 *
 * Returns key performance indicators for the dashboard:
 *   - todaySales        — total sales amount today
 *   - tokensGenerated   — number of vend transactions today
 *   - activeMeters      — meters with Active or Arrears status
 *   - monthlyRevenue    — total revenue for the current month
 */
exports.getKPIs = async (_req, res) => {
  try {
    // Today's sales
    const [[todaySalesRow]] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS todaySales
       FROM transactions
       WHERE DATE(created_at) = CURDATE()
         AND status IN ('Success', 'Arrears')`
    );

    // Tokens generated today (Vend transactions)
    const [[tokensRow]] = await pool.query(
      `SELECT COUNT(*) AS tokensGenerated
       FROM transactions
       WHERE DATE(created_at) = CURDATE()
         AND type = 'Vend'`
    );

    // Active meters
    const [[metersRow]] = await pool.query(
      `SELECT COUNT(*) AS activeMeters
       FROM customers
       WHERE status IN ('Active', 'Arrears')`
    );

    // Monthly revenue
    const [[monthlyRow]] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS monthlyRevenue
       FROM transactions
       WHERE MONTH(created_at) = MONTH(CURDATE())
         AND YEAR(created_at) = YEAR(CURDATE())`
    );

    return res.json({
      todaySales: Number(todaySalesRow.todaySales),
      tokensGenerated: Number(tokensRow.tokensGenerated),
      activeMeters: Number(metersRow.activeMeters),
      monthlyRevenue: Number(monthlyRow.monthlyRevenue),
    });
  } catch (err) {
    logger.error('Get KPIs error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: true,
      message: 'Internal server error.',
    });
  }
};

/**
 * GET /api/v1/dashboard/recent-transactions
 *
 * Returns the most recent transactions joined with customer name.
 * Accepts an optional `limit` query parameter (default 10).
 */
exports.getRecentTransactions = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);

    const [rows] = await pool.query(
      `SELECT t.*, c.name AS customer
       FROM transactions t
       JOIN customers c ON t.customer_id = c.id
       ORDER BY t.created_at DESC
       LIMIT ?`,
      [limit]
    );

    // MySQL returns DECIMAL columns as strings — cast to numbers
    const parsed = rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      kwh: Number(r.kwh),
    }));

    return res.json(parsed);
  } catch (err) {
    logger.error('Get recent transactions error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: true,
      message: 'Internal server error.',
    });
  }
};

/**
 * GET /api/v1/dashboard/sales-trend
 *
 * Returns daily sales totals for the last 7 days, formatted with
 * abbreviated day names (Mon, Tue, ...) and "Today" for the current day.
 */
exports.getSalesTrend = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DATE(created_at) AS date, SUM(amount) AS amount
       FROM transactions
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date`
    );

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const trend = rows.map((row) => {
      const rowDate = new Date(row.date);
      rowDate.setHours(0, 0, 0, 0);

      const isToday = rowDate.getTime() === today.getTime();
      const day = isToday ? 'Today' : dayNames[rowDate.getDay()];

      return {
        day,
        amount: Number(row.amount),
      };
    });

    return res.json(trend);
  } catch (err) {
    logger.error('Get sales trend error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: true,
      message: 'Internal server error.',
    });
  }
};
