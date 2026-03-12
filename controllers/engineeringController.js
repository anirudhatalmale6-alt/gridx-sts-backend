const pool = require('../config/database');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Helper — generate a 20-digit engineering STS token (prefix 1xxx)
// Formatted as XXXX-XXXX-XXXX-XXXX-XXXX per IEC 62055-41
// ---------------------------------------------------------------------------
function generateEngineeringToken() {
  // Engineering tokens start with '1' followed by 19 random digits
  let digits = '1';
  for (let i = 0; i < 19; i++) {
    digits += Math.floor(Math.random() * 10).toString();
  }
  return digits.replace(/(.{4})/g, '$1-').slice(0, 24); // 24 chars with dashes
}

// ---------------------------------------------------------------------------
// Helper — generate a 20-digit standard STS token
// ---------------------------------------------------------------------------
function generateStsToken() {
  let digits = '';
  for (let i = 0; i < 20; i++) {
    digits += Math.floor(Math.random() * 10).toString();
  }
  return digits.replace(/(.{4})/g, '$1-').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Helper — generate a unique transaction reference TXN-YYYYMMDDHHMMSSmmm
// ---------------------------------------------------------------------------
function generateReference() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const stamp =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) +
    pad(now.getMilliseconds(), 3);
  return `TXN-${stamp}`;
}

// ===========================================================================
// POST /engineering-token
// Generate special STS engineering tokens per IEC 62055-41
// ===========================================================================
exports.generateEngineeringToken = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { meterNo, tokenType, parameters } = req.body;

    if (!meterNo || !tokenType) {
      return res.status(400).json({
        success: false,
        message: 'meterNo and tokenType are required.',
      });
    }

    const validTypes = ['set_maximum_power_limit', 'clear_tamper', 'set_tariff_rate', 'meter_test'];
    if (!validTypes.includes(tokenType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid tokenType. Must be one of: ${validTypes.join(', ')}`,
      });
    }

    // Validate parameters based on token type
    if (tokenType === 'set_maximum_power_limit') {
      if (!parameters || !parameters.limit_kw || parameters.limit_kw <= 0) {
        return res.status(400).json({
          success: false,
          message: 'parameters.limit_kw (positive number) is required for set_maximum_power_limit.',
        });
      }
    }

    if (tokenType === 'set_tariff_rate') {
      if (!parameters || parameters.tariff_index === undefined || parameters.tariff_index === null) {
        return res.status(400).json({
          success: false,
          message: 'parameters.tariff_index is required for set_tariff_rate.',
        });
      }
    }

    // Look up customer by meter number
    const [customers] = await conn.query(
      'SELECT * FROM customers WHERE meter_no = ? LIMIT 1',
      [meterNo]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No customer found with meter number ${meterNo}.`,
      });
    }

    const customer = customers[0];
    const token = generateEngineeringToken();
    const reference = generateReference();

    await conn.beginTransaction();

    try {
      // Insert transaction record
      await conn.query(
        `INSERT INTO transactions
           (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, token_type, breakdown)
         VALUES (?, ?, ?, 0, 0, ?, ?, NULL, 'Success', 'Engineering', 'engineering', ?)`,
        [
          reference,
          customer.id,
          meterNo,
          token,
          req.user ? req.user.id : null,
          JSON.stringify({
            tokenType,
            parameters: parameters || null,
          }),
        ]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'engineering', ?)`,
        [
          'ENGINEERING_TOKEN_GENERATED',
          JSON.stringify({
            reference,
            meterNo,
            tokenType,
            parameters: parameters || null,
            customerName: customer.name,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Engineering token generated: ${reference} | Type: ${tokenType} | Meter: ${meterNo}`, {
        reference,
        meterNo,
        tokenType,
      });

      return res.status(201).json({
        success: true,
        token,
        type: tokenType,
        meterNo,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('generateEngineeringToken failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to generate engineering token.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// POST /free-units
// Generate a free-issue token for a given kWh amount (no payment)
// ===========================================================================
exports.generateFreeUnits = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { meterNo, kwh, reason } = req.body;

    if (!meterNo || !kwh || kwh <= 0) {
      return res.status(400).json({
        success: false,
        message: 'meterNo and a positive kwh value are required.',
      });
    }

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'A reason for the free units is required.',
      });
    }

    // Look up customer by meter number
    const [customers] = await conn.query(
      'SELECT * FROM customers WHERE meter_no = ? LIMIT 1',
      [meterNo]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No customer found with meter number ${meterNo}.`,
      });
    }

    const customer = customers[0];
    const token = generateStsToken();
    const reference = generateReference();

    await conn.beginTransaction();

    try {
      // Insert transaction record — amount=0 since no payment involved
      await conn.query(
        `INSERT INTO transactions
           (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, token_type, breakdown)
         VALUES (?, ?, ?, 0, ?, ?, ?, NULL, 'Success', 'FreeIssue', 'free_units', ?)`,
        [
          reference,
          customer.id,
          meterNo,
          kwh,
          token,
          req.user ? req.user.id : null,
          JSON.stringify({ reason }),
        ]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'engineering', ?)`,
        [
          'FREE_UNITS_ISSUED',
          JSON.stringify({
            reference,
            meterNo,
            kwh,
            reason,
            customerName: customer.name,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Free units issued: ${reference} | Meter: ${meterNo} | kWh: ${kwh}`, {
        reference,
        meterNo,
        kwh,
        reason,
      });

      return res.status(201).json({
        success: true,
        token,
        kwh,
        reference,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('generateFreeUnits failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to generate free units token.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// POST /key-change
// Generate a key change token for STS encryption key rotation
// ===========================================================================
exports.generateKeyChangeToken = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { meterNo, newKeyRevision } = req.body;

    if (!meterNo || newKeyRevision === undefined || newKeyRevision === null) {
      return res.status(400).json({
        success: false,
        message: 'meterNo and newKeyRevision are required.',
      });
    }

    // Look up customer by meter number
    const [customers] = await conn.query(
      'SELECT * FROM customers WHERE meter_no = ? LIMIT 1',
      [meterNo]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No customer found with meter number ${meterNo}.`,
      });
    }

    const customer = customers[0];
    const token = generateEngineeringToken();
    const reference = generateReference();

    await conn.beginTransaction();

    try {
      // Insert transaction record
      await conn.query(
        `INSERT INTO transactions
           (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, token_type, breakdown)
         VALUES (?, ?, ?, 0, 0, ?, ?, NULL, 'Success', 'KeyChange', 'key_change', ?)`,
        [
          reference,
          customer.id,
          meterNo,
          token,
          req.user ? req.user.id : null,
          JSON.stringify({
            previousKeyRevision: customer.key_revision || null,
            newKeyRevision,
          }),
        ]
      );

      // Update customer's key_revision
      await conn.query(
        'UPDATE customers SET key_revision = ? WHERE id = ?',
        [newKeyRevision, customer.id]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'engineering', ?)`,
        [
          'KEY_CHANGE_TOKEN_GENERATED',
          JSON.stringify({
            reference,
            meterNo,
            previousKeyRevision: customer.key_revision || null,
            newKeyRevision,
            customerName: customer.name,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Key change token generated: ${reference} | Meter: ${meterNo} | New revision: ${newKeyRevision}`, {
        reference,
        meterNo,
        newKeyRevision,
      });

      return res.status(201).json({
        success: true,
        token,
        newKeyRevision,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('generateKeyChangeToken failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to generate key change token.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// POST /replacement-token
// Regenerate a token from an original transaction
// ===========================================================================
exports.generateReplacementToken = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { originalReference } = req.body;

    if (!originalReference) {
      return res.status(400).json({
        success: false,
        message: 'originalReference is required.',
      });
    }

    // Look up the original transaction
    const [transactions] = await conn.query(
      'SELECT * FROM transactions WHERE reference = ? LIMIT 1',
      [originalReference]
    );

    if (transactions.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Original transaction with reference "${originalReference}" not found.`,
      });
    }

    const original = transactions[0];

    if (original.status === 'Reversed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot generate a replacement token for a reversed transaction.',
      });
    }

    const token = generateStsToken();
    const reference = generateReference();

    await conn.beginTransaction();

    try {
      // Insert replacement transaction with same parameters as original
      await conn.query(
        `INSERT INTO transactions
           (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, token_type, breakdown)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Success', 'Vend', 'replacement', ?)`,
        [
          reference,
          original.customer_id,
          original.meter_no,
          original.amount,
          original.kwh,
          token,
          req.user ? req.user.id : null,
          original.vendor_id,
          JSON.stringify({
            originalReference,
            originalToken: original.token,
            originalBreakdown: typeof original.breakdown === 'string'
              ? JSON.parse(original.breakdown)
              : original.breakdown || {},
          }),
        ]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'engineering', ?)`,
        [
          'REPLACEMENT_TOKEN_GENERATED',
          JSON.stringify({
            reference,
            originalReference,
            meterNo: original.meter_no,
            amount: original.amount,
            kwh: original.kwh,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Replacement token generated: ${reference} | Original: ${originalReference}`, {
        reference,
        originalReference,
      });

      return res.status(201).json({
        success: true,
        token,
        originalReference,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('generateReplacementToken failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to generate replacement token.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};
