const pool = require('../config/database');
const logger = require('../config/logger');

// ===========================================================================
// GET /meters — list all customers with GPS coordinates (map markers)
// ===========================================================================
exports.getMeterLocations = async (req, res) => {
  try {
    const { area, status, tariffGroup } = req.query;
    const conditions = ['gps_lat IS NOT NULL', 'gps_lng IS NOT NULL'];
    const params = [];

    if (area) {
      conditions.push('area = ?');
      params.push(area);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (tariffGroup) {
      conditions.push('tariff_group = ?');
      params.push(tariffGroup);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT id, account_no, name, meter_no, area, status, tariff_group,
              gps_lat AS lat, gps_lng AS lng, balance, arrears
       FROM customers
       ${whereClause}
       ORDER BY area ASC, name ASC`,
      params
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    logger.error('mapController.getMeterLocations failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meter locations.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// GET /meters/:meterNo — get customer details + recent transactions for a meter
// ===========================================================================
exports.getMeterDetail = async (req, res) => {
  try {
    const { meterNo } = req.params;

    // Look up customer by meter number
    const [customers] = await pool.query(
      'SELECT * FROM customers WHERE meter_no = ? LIMIT 1',
      [meterNo]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No customer found with meter number "${meterNo}".`,
      });
    }

    const customer = customers[0];

    // Get last 5 transactions for this meter
    const [recentTransactions] = await pool.query(
      `SELECT id, reference, amount, kwh, token, type, status, breakdown, created_at
       FROM transactions
       WHERE meter_no = ?
       ORDER BY created_at DESC
       LIMIT 5`,
      [meterNo]
    );

    // Parse breakdown JSON for each transaction
    for (const txn of recentTransactions) {
      if (typeof txn.breakdown === 'string') {
        try {
          txn.breakdown = JSON.parse(txn.breakdown);
        } catch (_) {
          // leave as-is if unparseable
        }
      }
    }

    return res.json({
      success: true,
      customer,
      recentTransactions,
    });
  } catch (err) {
    logger.error('mapController.getMeterDetail failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meter detail.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// GET /areas — area-level summary (meter counts, balances, arrears)
// ===========================================================================
exports.getAreaSummary = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         area,
         COUNT(*) AS meterCount,
         ROUND(COALESCE(SUM(balance), 0), 2) AS totalBalance,
         ROUND(COALESCE(SUM(arrears), 0), 2) AS totalArrears,
         SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS activeCount,
         SUM(CASE WHEN status != 'Active' THEN 1 ELSE 0 END) AS inactiveCount
       FROM customers
       GROUP BY area
       ORDER BY area ASC`
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    logger.error('mapController.getAreaSummary failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch area summary.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};
