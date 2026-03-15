const pool = require('../config/database');
const logger = require('../config/logger');

// Reason code lookup (matches MCU RelayChangeReason enum)
const REASON_CODES = {
  0: 'Unknown',
  1: 'Manual Control',
  2: 'Credit Expired',
  3: 'Power Limit',
  4: 'Scheduled',
  5: 'Remote Command',
  6: 'System Startup',
  7: 'Tamper Detected',
  8: 'Overcurrent',
};

const RELAY_NAMES = { 0: 'Mains', 1: 'Geyser' };
const ENTRY_TYPES = { 0: 'State Change', 1: 'Control Change' };

/**
 * POST - Receive relay events from meter (no JWT — meter uses API key)
 * Body: { events: [ { timestamp, relay_index, entry_type, state, control, reason, reason_text, trigger } ] }
 * OR single event: { timestamp, relay_index, entry_type, state, control, reason, reason_text, trigger }
 */
exports.receiveRelayEvents = async (req, res) => {
  const drn = req.params.DRN || req.params.drn;

  try {
    // Support both single event and batch (array)
    let events = req.body.events || (Array.isArray(req.body) ? req.body : [req.body]);

    if (!events || events.length === 0) {
      return res.status(400).json({ success: false, message: 'No relay events provided.' });
    }

    let inserted = 0;
    for (const evt of events) {
      const {
        relay_index = 0,
        entry_type = 0,
        state,
        control,
        reason = 0,
        reason_text = '',
        trigger = 0,
        timestamp,
      } = evt;

      await pool.query(
        `INSERT INTO meter_relay_events
           (drn, relay_index, entry_type, state, control, reason_code, reason_text, trigger_type, meter_timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
        [
          drn,
          relay_index,
          entry_type,
          state !== undefined ? state : null,
          control !== undefined ? control : null,
          reason,
          reason_text || '',
          trigger,
          timestamp || Math.floor(Date.now() / 1000),
        ]
      );
      inserted++;
    }

    logger.info(`Relay events received for meter ${drn}`, { drn, count: inserted });
    return res.status(201).json({ success: true, message: `${inserted} relay event(s) stored` });
  } catch (err) {
    logger.error('receiveRelayEvents failed', { error: err.message, drn });
    return res.status(500).json({ success: false, message: 'Failed to store relay events.' });
  }
};

/**
 * GET - Retrieve relay events for a meter (JWT auth — dashboard)
 * Query params: limit (default 100), offset (default 0), relay (0=mains, 1=geyser), type (0=state, 1=control)
 */
exports.getRelayEvents = async (req, res) => {
  const { drn } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const relay = req.query.relay;
  const type = req.query.type;

  try {
    let query = `SELECT * FROM meter_relay_events WHERE drn = ?`;
    const params = [drn];

    if (relay !== undefined && relay !== '') {
      query += ` AND relay_index = ?`;
      params.push(parseInt(relay));
    }
    if (type !== undefined && type !== '') {
      query += ` AND entry_type = ?`;
      params.push(parseInt(type));
    }

    query += ` ORDER BY received_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await pool.query(query, params);

    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) as total FROM meter_relay_events WHERE drn = ?`;
    const countParams = [drn];
    if (relay !== undefined && relay !== '') {
      countQuery += ` AND relay_index = ?`;
      countParams.push(parseInt(relay));
    }
    if (type !== undefined && type !== '') {
      countQuery += ` AND entry_type = ?`;
      countParams.push(parseInt(type));
    }
    const [countResult] = await pool.query(countQuery, countParams);

    // Enrich with human-readable labels
    const enriched = rows.map((row) => ({
      ...row,
      relay_name: RELAY_NAMES[row.relay_index] || `Relay ${row.relay_index}`,
      entry_type_name: ENTRY_TYPES[row.entry_type] || `Type ${row.entry_type}`,
      reason_name: REASON_CODES[row.reason_code] || `Code ${row.reason_code}`,
    }));

    return res.json({
      success: true,
      data: enriched,
      pagination: {
        total: countResult[0].total,
        limit,
        offset,
      },
    });
  } catch (err) {
    logger.error('getRelayEvents failed', { error: err.message, drn });
    return res.status(500).json({ success: false, message: 'Failed to retrieve relay events.' });
  }
};

/**
 * GET - Summary stats for relay events (JWT auth — dashboard)
 */
exports.getRelayEventSummary = async (req, res) => {
  const { drn } = req.params;
  const hours = parseInt(req.query.hours) || 24;

  try {
    const [stats] = await pool.query(
      `SELECT
         relay_index,
         entry_type,
         reason_code,
         COUNT(*) as event_count,
         MAX(meter_timestamp) as last_event
       FROM meter_relay_events
       WHERE drn = ? AND received_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       GROUP BY relay_index, entry_type, reason_code
       ORDER BY event_count DESC`,
      [drn, hours]
    );

    const [totalCount] = await pool.query(
      `SELECT COUNT(*) as total FROM meter_relay_events WHERE drn = ?`,
      [drn]
    );

    const enrichedStats = stats.map((row) => ({
      ...row,
      relay_name: RELAY_NAMES[row.relay_index] || `Relay ${row.relay_index}`,
      entry_type_name: ENTRY_TYPES[row.entry_type] || `Type ${row.entry_type}`,
      reason_name: REASON_CODES[row.reason_code] || `Code ${row.reason_code}`,
    }));

    return res.json({
      success: true,
      data: {
        summary: enrichedStats,
        total_events: totalCount[0].total,
        period_hours: hours,
      },
    });
  } catch (err) {
    logger.error('getRelayEventSummary failed', { error: err.message, drn });
    return res.status(500).json({ success: false, message: 'Failed to retrieve relay event summary.' });
  }
};
