const pool = require('../config/database');
const logger = require('../config/logger');

/**
 * POST /api/v1/meter-health/:drn
 * Receives diagnostic data from the meter via SIM800 HTTP POST.
 */
exports.receiveHealthData = async (req, res) => {
  const { drn } = req.params;

  try {
    const {
      health_score,
      uart_errors,
      relay_mismatches,
      power_anomalies,
      voltage,
      current,
      active_power,
      frequency,
      power_factor,
      temperature,
      mains_state,
      mains_control,
      geyser_state,
      geyser_control,
      firmware,
      uptime,
      timestamp,
    } = req.body;

    await pool.query(
      `INSERT INTO meter_health
         (drn, health_score, uart_errors, relay_mismatches, power_anomalies,
          voltage, current_a, active_power, frequency, power_factor, temperature,
          mains_state, mains_control, geyser_state, geyser_control,
          firmware, uptime_seconds, meter_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
      [
        drn,
        health_score || 0,
        uart_errors || 0,
        relay_mismatches || 0,
        power_anomalies || 0,
        voltage || 0,
        current || 0,
        active_power || 0,
        frequency || 0,
        power_factor || 0,
        temperature || 0,
        mains_state || 0,
        mains_control || 0,
        geyser_state || 0,
        geyser_control || 0,
        firmware || '',
        uptime || 0,
        timestamp || Math.floor(Date.now() / 1000),
      ]
    );

    logger.info(`Health data received for meter ${drn}`, { drn, health_score });

    return res.status(201).json({ success: true, message: 'Health data stored' });
  } catch (err) {
    logger.error('receiveHealthData failed', { error: err.message, drn });
    return res.status(500).json({
      success: false,
      message: 'Failed to store health data.',
    });
  }
};

/**
 * GET /api/v1/meter-health/:drn
 * Returns the latest health report for a specific meter.
 */
exports.getLatestHealth = async (req, res) => {
  const { drn } = req.params;

  try {
    const [rows] = await pool.query(
      `SELECT * FROM meter_health
       WHERE drn = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [drn]
    );

    if (rows.length === 0) {
      return res.json({
        success: true,
        data: null,
        message: 'No health data available for this meter.',
      });
    }

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    logger.error('getLatestHealth failed', { error: err.message, drn });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch health data.',
    });
  }
};

/**
 * GET /api/v1/meter-health/:drn/history
 * Returns health history (last 168 records = ~7 days at 1hr interval).
 */
exports.getHealthHistory = async (req, res) => {
  const { drn } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 168, 500);

  try {
    const [rows] = await pool.query(
      `SELECT * FROM meter_health
       WHERE drn = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [drn, limit]
    );

    return res.json({ success: true, data: rows, total: rows.length });
  } catch (err) {
    logger.error('getHealthHistory failed', { error: err.message, drn });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch health history.',
    });
  }
};
