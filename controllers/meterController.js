/**
 * GRIDx STS Backend — Meter Communication Controller
 *
 * Handles all communication between the ESP32 GRIDx meters and this server.
 * The meter uses a SIM800 GSM modem to POST JSON to these endpoints.
 *
 * Protocol (from meter firmware api.cpp):
 *   - Meter registers via POST /meters/getAccessToken with {"DRN":"..."}
 *   - Meter posts telemetry arrays to /meterPower/MeterLog/:DRN, etc.
 *   - Server responds with pending tokens ("tk") and commands ("ms","mc","gc","gs", etc.)
 *
 * Token Delivery Flow:
 *   1. Operator vends token via /api/v1/vending/generate-token
 *   2. Token is queued in token_delivery_queue with status='pending'
 *   3. When meter POSTs telemetry, response includes {"tk":"20-digit-token"}
 *   4. Queue entry marked 'delivered'
 *   5. Meter processes token and reports back via /meterSTSTokesInfo
 */

const pool = require('../config/database');
const logger = require('../config/logger');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
//  Helper: Generate API key for meter authentication
// ---------------------------------------------------------------------------
function generateApiKey() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
//  Helper: Auto-register or touch meter in registry
// ---------------------------------------------------------------------------
async function ensureMeterRegistered(conn, drn) {
  const [rows] = await conn.query('SELECT id FROM meter_registry WHERE drn = ?', [drn]);
  if (rows.length === 0) {
    await conn.query(
      'INSERT INTO meter_registry (drn, status, last_seen) VALUES (?, ?, NOW())',
      [drn, 'Online']
    );
    logger.info(`[meter] Auto-registered meter ${drn}`);
  } else {
    await conn.query(
      'UPDATE meter_registry SET last_seen = NOW(), status = ? WHERE drn = ?',
      ['Online', drn]
    );
  }
}

// ---------------------------------------------------------------------------
//  Helper: Link meter DRN to existing customer by meter_no
// ---------------------------------------------------------------------------
async function linkMeterToCustomer(conn, drn) {
  // Try matching meter_no in customers table
  const [customers] = await conn.query(
    'SELECT id FROM customers WHERE meter_no = ? LIMIT 1',
    [drn]
  );
  if (customers.length > 0) {
    await conn.query(
      'UPDATE meter_registry SET customer_id = ? WHERE drn = ?',
      [customers[0].id, drn]
    );
  }
}

// ---------------------------------------------------------------------------
//  Helper: Build response with pending tokens and commands
// ---------------------------------------------------------------------------
async function buildMeterResponse(conn, drn) {
  const response = {};

  // 1. Pending token (deliver one at a time, oldest first)
  const [pendingTokens] = await conn.query(
    `SELECT id, token, transaction_id FROM token_delivery_queue
     WHERE drn = ? AND status = 'pending'
     ORDER BY created_at ASC LIMIT 1`,
    [drn]
  );

  if (pendingTokens.length > 0) {
    const tk = pendingTokens[0];
    response.tk = tk.token.replace(/-/g, ''); // Strip dashes for meter (20 digits only)
    await conn.query(
      `UPDATE token_delivery_queue SET status = 'delivered', delivered_at = NOW() WHERE id = ?`,
      [tk.id]
    );
    logger.info(`[meter] Delivered token ${response.tk} to ${drn} (queue #${tk.id})`);
  }

  // 2. Pending command (deliver one at a time)
  const [pendingCmds] = await conn.query(
    `SELECT id, command_json FROM meter_commands
     WHERE drn = ? AND status = 'queued'
     ORDER BY created_at ASC LIMIT 1`,
    [drn]
  );

  if (pendingCmds.length > 0) {
    const cmd = pendingCmds[0];
    try {
      const cmdObj = JSON.parse(cmd.command_json);
      Object.assign(response, cmdObj);
      await conn.query(
        `UPDATE meter_commands SET status = 'delivered', delivered_at = NOW() WHERE id = ?`,
        [cmd.id]
      );
      logger.info(`[meter] Delivered command to ${drn}: ${cmd.command_json}`);
    } catch (e) {
      logger.error(`[meter] Bad JSON in meter_commands id=${cmd.id}`);
    }
  }

  return response;
}

// ---------------------------------------------------------------------------
//  Helper: Store telemetry
// ---------------------------------------------------------------------------
async function storeTelemetry(conn, drn, type, data) {
  await conn.query(
    'INSERT INTO meter_telemetry (drn, type, data_json) VALUES (?, ?, ?)',
    [drn, type, JSON.stringify(data)]
  );
}

// ============================================================================
//  METER REGISTRATION
// ============================================================================

/**
 * POST /meters/getAccessToken
 * Body: { "DRN": "0000168453210" }
 * Response: { "accessToken": "hex32" }
 */
async function registerMeter(req, res) {
  const conn = await pool.getConnection();
  try {
    const { DRN } = req.body || {};
    if (!DRN) {
      return res.status(400).json({ error: 'Missing DRN in body' });
    }

    const apiKey = generateApiKey();

    await conn.query(
      `INSERT INTO meter_registry (drn, api_key, status, last_seen)
       VALUES (?, ?, 'Online', NOW())
       ON DUPLICATE KEY UPDATE
         api_key = VALUES(api_key),
         status = 'Online',
         last_seen = NOW()`,
      [DRN, apiKey]
    );

    await linkMeterToCustomer(conn, DRN);

    logger.info(`[meter] Registered meter ${DRN}, issued API key`);

    // Include any pending tokens/commands in registration response
    const extra = await buildMeterResponse(conn, DRN);

    return res.json({ accessToken: apiKey, ...extra });
  } catch (err) {
    logger.error('[meter] Registration error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
}

// ============================================================================
//  TELEMETRY HANDLERS — Generic factory
// ============================================================================

function createTelemetryHandler(type, updateLatest) {
  return async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const { DRN } = req.params;
      if (!DRN) return res.status(400).json({ error: 'Missing DRN' });

      await ensureMeterRegistered(conn, DRN);
      await storeTelemetry(conn, DRN, type, req.body);

      // Update latest snapshot table if provided
      if (updateLatest) {
        await updateLatest(conn, DRN, req.body);
      }

      // Build response with pending tokens/commands
      const response = await buildMeterResponse(conn, DRN);
      return res.json(response);
    } catch (err) {
      logger.error(`[meter/${type}] Error:`, err);
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      conn.release();
    }
  };
}

// ============================================================================
//  POWER DATA — POST /meterPower/MeterLog/:DRN
//  Array: [current_A, voltage_V, active_W, reactive_VAR, apparent_VA, temp_C, freq_Hz, pf, epoch]
// ============================================================================

async function updatePowerLatest(conn, drn, data) {
  if (!Array.isArray(data) || data.length < 9) return;
  await conn.query(
    `INSERT INTO meter_power_latest (drn, current_a, voltage_v, active_w, reactive_var, apparent_va, temperature_c, frequency_hz, power_factor, meter_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       current_a = VALUES(current_a),
       voltage_v = VALUES(voltage_v),
       active_w = VALUES(active_w),
       reactive_var = VALUES(reactive_var),
       apparent_va = VALUES(apparent_va),
       temperature_c = VALUES(temperature_c),
       frequency_hz = VALUES(frequency_hz),
       power_factor = VALUES(power_factor),
       meter_epoch = VALUES(meter_epoch),
       updated_at = NOW()`,
    [drn, data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8]]
  );
}

const handlePowerData = createTelemetryHandler('power', updatePowerLatest);

// ============================================================================
//  ENERGY DATA — POST /meterEnergy/MeterLog/:DRN
//  Array: [active_Wh, reactive_Wh, credit_kWh, tamper_flag, tamper_ts, reset_count, epoch]
// ============================================================================

async function updateEnergyLatest(conn, drn, data) {
  if (!Array.isArray(data) || data.length < 7) return;

  await conn.query(
    `INSERT INTO meter_energy_latest (drn, active_energy_wh, reactive_energy_wh, credit_kwh, tamper_flag, tamper_timestamp, reset_count, meter_epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       active_energy_wh = VALUES(active_energy_wh),
       reactive_energy_wh = VALUES(reactive_energy_wh),
       credit_kwh = VALUES(credit_kwh),
       tamper_flag = VALUES(tamper_flag),
       tamper_timestamp = VALUES(tamper_timestamp),
       reset_count = VALUES(reset_count),
       meter_epoch = VALUES(meter_epoch),
       updated_at = NOW()`,
    [drn, data[0], data[1], data[2], data[3], data[4], data[5], data[6]]
  );

  // Update tamper status if detected
  if (data[3] !== 0) {
    await conn.query(
      "UPDATE meter_registry SET status = 'Tampered' WHERE drn = ? AND status != 'Tampered'",
      [drn]
    );
  }
}

const handleEnergyData = createTelemetryHandler('energy', updateEnergyLatest);

// ============================================================================
//  CELLULAR INFO — POST /meterCellNetwork/MeterLog/:DRN
//  Array: [RSSI, operator_name, phone_number, IMEI, epoch]
// ============================================================================

async function updateCellularInfo(conn, drn, data) {
  if (!Array.isArray(data) || data.length < 4) return;
  await conn.query(
    `UPDATE meter_registry SET
       operator_name = ?,
       phone = ?,
       imei = ?
     WHERE drn = ?`,
    [data[1] || null, data[2] || null, data[3] || null, drn]
  );
}

const handleCellularInfo = createTelemetryHandler('cellular', updateCellularInfo);

// ============================================================================
//  LOAD CONTROL — POST /meterLoadControl/MeterLog/:DRN
// ============================================================================
const handleLoadControl = createTelemetryHandler('load', null);

// ============================================================================
//  TOKEN INFO — POST /meterSTSTokesInfo/MeterLog/:DRN
//  Meter reports token acceptance/rejection
// ============================================================================

async function processTokenFeedback(conn, drn, data) {
  // The meter may report token status in various formats
  const token = data?.token || data?.tk;
  const accepted = data?.accepted === true || data?.status === 'accepted' ||
                   data?.display_msg === 'Accept';
  const rejected = data?.accepted === false || data?.status === 'rejected' ||
                   (data?.display_msg && data.display_msg.startsWith('Reject'));

  if (token && (accepted || rejected)) {
    const [rows] = await conn.query(
      `SELECT id FROM token_delivery_queue
       WHERE drn = ? AND REPLACE(token, '-', '') = ? AND status = 'delivered'
       LIMIT 1`,
      [drn, token.replace(/-/g, '')]
    );

    if (rows.length > 0) {
      const newStatus = accepted ? 'accepted' : 'rejected';
      const timeCol = accepted ? 'accepted_at' : 'rejected_at';
      await conn.query(
        `UPDATE token_delivery_queue SET status = ?, ${timeCol} = NOW() WHERE id = ?`,
        [newStatus, rows[0].id]
      );
      logger.info(`[meter] Token ${accepted ? 'ACCEPTED' : 'REJECTED'} by ${drn} (queue #${rows[0].id})`);
    }
  }
}

const handleTokenInfo = createTelemetryHandler('token_info', processTokenFeedback);

// ============================================================================
//  CREDIT TRANSFER — POST /credit/MeterLog/:DRN
// ============================================================================
const handleCreditTransfer = createTelemetryHandler('credit', null);

// ============================================================================
//  DASHBOARD API — Meter overview for frontend
// ============================================================================

/**
 * GET /api/v1/meter/list — All registered meters with latest telemetry
 */
async function listMeters(req, res) {
  const conn = await pool.getConnection();
  try {
    const [meters] = await conn.query(`
      SELECT
        mr.*,
        mpl.current_a, mpl.voltage_v, mpl.active_w, mpl.power_factor,
        mpl.frequency_hz, mpl.temperature_c,
        mel.active_energy_wh, mel.credit_kwh, mel.tamper_flag, mel.reset_count,
        c.name AS customer_name, c.account_no, c.area, c.tariff_group
      FROM meter_registry mr
      LEFT JOIN meter_power_latest mpl ON mr.drn = mpl.drn
      LEFT JOIN meter_energy_latest mel ON mr.drn = mel.drn
      LEFT JOIN customers c ON mr.customer_id = c.id
      ORDER BY mr.last_seen DESC
    `);

    return res.json({ count: meters.length, meters });
  } catch (err) {
    logger.error('[meter] List error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
}

/**
 * GET /api/v1/meter/:drn — Single meter detail with telemetry history
 */
async function getMeterDetail(req, res) {
  const conn = await pool.getConnection();
  try {
    const { drn } = req.params;

    const [meters] = await conn.query(`
      SELECT mr.*,
        mpl.current_a, mpl.voltage_v, mpl.active_w, mpl.reactive_var,
        mpl.apparent_va, mpl.temperature_c, mpl.frequency_hz, mpl.power_factor,
        mel.active_energy_wh, mel.reactive_energy_wh, mel.credit_kwh,
        mel.tamper_flag, mel.tamper_timestamp, mel.reset_count,
        c.name AS customer_name, c.account_no, c.area, c.tariff_group, c.phone AS customer_phone
      FROM meter_registry mr
      LEFT JOIN meter_power_latest mpl ON mr.drn = mpl.drn
      LEFT JOIN meter_energy_latest mel ON mr.drn = mel.drn
      LEFT JOIN customers c ON mr.customer_id = c.id
      WHERE mr.drn = ?
    `, [drn]);

    if (meters.length === 0) {
      return res.status(404).json({ error: 'Meter not found' });
    }

    // Recent telemetry
    const [telemetry] = await conn.query(
      'SELECT id, type, data_json, received_at FROM meter_telemetry WHERE drn = ? ORDER BY received_at DESC LIMIT 50',
      [drn]
    );

    // Token delivery history
    const [tokens] = await conn.query(
      'SELECT * FROM token_delivery_queue WHERE drn = ? ORDER BY created_at DESC LIMIT 20',
      [drn]
    );

    // Command history
    const [commands] = await conn.query(
      'SELECT * FROM meter_commands WHERE drn = ? ORDER BY created_at DESC LIMIT 20',
      [drn]
    );

    return res.json({
      meter: meters[0],
      telemetry: telemetry.map(t => {
        try { t.data = JSON.parse(t.data_json); } catch { t.data = t.data_json; }
        return t;
      }),
      tokens,
      commands
    });
  } catch (err) {
    logger.error('[meter] Detail error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
}

/**
 * POST /api/v1/meter/:drn/command — Queue a command for the meter
 */
async function sendCommand(req, res) {
  const conn = await pool.getConnection();
  try {
    const { drn } = req.params;
    const { command } = req.body || {};

    if (!command) return res.status(400).json({ error: 'Missing "command"' });

    const commandMap = {
      relay_on:       { mc: 1, ms: 1 },
      relay_off:      { mc: 1, ms: 0 },
      geyser_on:      { gc: 1, gs: 1 },
      geyser_off:     { gc: 1, gs: 0 },
      reset:          { mr: 1 },
      bt_reset:       { br: 1 },
      sleep:          { sd: 1 },
      wake:           { sd: 0 },
    };

    let commandJson;
    let commandType;

    if (typeof command === 'string' && commandMap[command]) {
      commandJson = commandMap[command];
      commandType = command;
    } else if (typeof command === 'object') {
      commandJson = command;
      commandType = 'custom';
    } else {
      return res.status(400).json({
        error: `Unknown command "${command}". Valid: ${Object.keys(commandMap).join(', ')}`
      });
    }

    const [result] = await conn.query(
      `INSERT INTO meter_commands (drn, command_type, command_json, requested_by)
       VALUES (?, ?, ?, ?)`,
      [drn, commandType, JSON.stringify(commandJson), req.user?.id || null]
    );

    logger.info(`[meter] Command queued for ${drn}: ${JSON.stringify(commandJson)} (id #${result.insertId})`);

    return res.status(201).json({
      id: result.insertId,
      drn,
      command: commandJson,
      command_type: commandType,
      status: 'queued',
      message: 'Command will be delivered on next meter check-in'
    });
  } catch (err) {
    logger.error('[meter] Command error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
}

/**
 * POST /api/v1/meter/:drn/send-token — Manually queue a token for delivery
 */
async function sendToken(req, res) {
  const conn = await pool.getConnection();
  try {
    const { drn } = req.params;
    const { token, transaction_id, delivery_method } = req.body || {};

    if (!token) return res.status(400).json({ error: 'Missing "token"' });

    const [result] = await conn.query(
      `INSERT INTO token_delivery_queue (drn, token, transaction_id, delivery_method)
       VALUES (?, ?, ?, ?)`,
      [drn, token, transaction_id || null, delivery_method || 'api']
    );

    logger.info(`[meter] Token queued for ${drn}: ${token} (queue #${result.insertId})`);

    return res.status(201).json({
      id: result.insertId,
      drn,
      token,
      status: 'pending',
      message: 'Token queued for delivery on next meter check-in'
    });
  } catch (err) {
    logger.error('[meter] Send token error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
}

/**
 * GET /api/v1/meter/token-queue — View all pending token deliveries
 */
async function getTokenQueue(req, res) {
  const conn = await pool.getConnection();
  try {
    const [queue] = await conn.query(`
      SELECT tdq.*, c.name AS customer_name, t.amount, t.reference
      FROM token_delivery_queue tdq
      LEFT JOIN transactions t ON tdq.transaction_id = t.id
      LEFT JOIN customers c ON t.customer_id = c.id
      ORDER BY tdq.created_at DESC
      LIMIT 100
    `);

    return res.json({ count: queue.length, queue });
  } catch (err) {
    logger.error('[meter] Token queue error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
}

// ============================================================================
//  MODULE EXPORTS
// ============================================================================
module.exports = {
  registerMeter,
  handlePowerData,
  handleEnergyData,
  handleCellularInfo,
  handleLoadControl,
  handleTokenInfo,
  handleCreditTransfer,
  listMeters,
  getMeterDetail,
  sendCommand,
  sendToken,
  getTokenQueue,
};
