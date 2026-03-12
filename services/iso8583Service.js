const net = require('net');
const pool = require('../config/database');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Helper — generate a 20-digit STS-style token formatted as XXXX-XXXX-XXXX-XXXX-XXXX
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

// ---------------------------------------------------------------------------
// Helper — load system_config rows into a key-value object
// ---------------------------------------------------------------------------
async function getSystemConfig(connection) {
  const [rows] = await connection.query('SELECT config_key, config_value FROM system_config');
  const config = {};
  for (const row of rows) {
    config[row.config_key] = row.config_value;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Helper — calculate kWh from step tariff blocks
// ---------------------------------------------------------------------------
function calculateKwhFromBlocks(blocks, electricityAmount) {
  let remaining = electricityAmount;
  let totalKwh = 0;

  for (const block of blocks) {
    if (remaining <= 0) break;

    const blockSize = block.range_end !== null
      ? parseFloat(block.range_end) - parseFloat(block.range_start)
      : Infinity;

    const rate = parseFloat(block.rate);
    if (rate <= 0) continue;

    const maxCostForBlock = blockSize === Infinity ? remaining : blockSize * rate;
    const costInBlock = Math.min(remaining, maxCostForBlock);
    const kwhInBlock = costInBlock / rate;

    totalKwh += kwhInBlock;
    remaining -= costInBlock;
  }

  return Math.round(totalKwh * 100) / 100;
}

// ===========================================================================
// Simplified ISO 8583 Message Parser
//
// Format:  [4-byte MTI][JSON payload]
//
// This is a simplified implementation. A full ISO 8583 implementation with
// bitmaps and packed BCD fields is very complex; this uses a JSON payload
// approach to carry the field data while maintaining the MTI header for
// message-type routing.
// ===========================================================================

/**
 * Parse a raw buffer into an ISO 8583 message object.
 * @param {Buffer} data - Raw TCP data
 * @returns {{ mti: string, fields: object }} Parsed message
 */
function parseISO8583(data) {
  const mti = data.slice(0, 4).toString('utf8');
  let fields = {};

  try {
    const jsonStr = data.slice(4).toString('utf8');
    if (jsonStr.length > 0) {
      fields = JSON.parse(jsonStr);
    }
  } catch {
    logger.warn('ISO 8583: Failed to parse JSON payload, treating as empty fields');
  }

  return { mti, fields };
}

/**
 * Build an ISO 8583 response buffer.
 * @param {string} mti - 4-char message type indicator
 * @param {object} fields - Response fields
 * @returns {Buffer} Wire-format response
 */
function buildISO8583(mti, fields) {
  const payload = JSON.stringify(fields);
  const header = Buffer.from(mti, 'utf8');
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([header, body]);
}

// ===========================================================================
// Handle MTI 0200 — Financial Transaction Request (Vend)
// ===========================================================================
async function handleVendRequest(fields) {
  const meterNo = fields['42'] || fields.meterNo;
  const amount = parseFloat(fields['4'] || fields.amount || 0);

  if (!meterNo || !amount || amount <= 0) {
    return {
      responseCode: '14', // Invalid card number / missing data
      message: 'Missing meter number or invalid amount',
    };
  }

  const conn = await pool.getConnection();
  try {
    // Look up customer
    const [customers] = await conn.query(
      'SELECT * FROM customers WHERE meter_no = ? LIMIT 1',
      [meterNo]
    );

    if (customers.length === 0) {
      return { responseCode: '14', message: `Meter ${meterNo} not found` };
    }

    const customer = customers[0];

    // Get tariff blocks
    const [blocks] = await conn.query(
      'SELECT * FROM tariff_blocks WHERE tariff_group_code = ? ORDER BY range_start ASC',
      [customer.tariff_group]
    );

    if (blocks.length === 0) {
      return { responseCode: '96', message: 'Tariff configuration error' };
    }

    // Get system config
    const sysConfig = await getSystemConfig(conn);
    const vatRate = parseFloat(sysConfig.vatRate || '0');
    const fixedCharge = parseFloat(sysConfig.fixedCharge || '0');
    const relLevy = parseFloat(sysConfig.relLevy || '0');

    // Calculate deductions
    let deductions = fixedCharge + relLevy;
    let arrearsDeduction = 0;
    const customerArrears = parseFloat(customer.arrears) || 0;

    if (customerArrears > 0) {
      arrearsDeduction = Math.min(customerArrears, amount * 0.2);
      arrearsDeduction = Math.round(arrearsDeduction * 100) / 100;
      deductions += arrearsDeduction;
    }

    const vatAmount = Math.round(((amount - deductions) * (vatRate / (100 + vatRate))) * 100) / 100;
    const electricityAmount = Math.round((amount - deductions - vatAmount) * 100) / 100;

    if (electricityAmount <= 0) {
      return { responseCode: '51', message: 'Amount too low after deductions' };
    }

    const kwh = calculateKwhFromBlocks(blocks, electricityAmount);
    const token = generateStsToken();
    const reference = generateReference();

    const breakdown = {
      amountTendered: amount,
      vat: vatAmount,
      fixedCharge,
      relLevy,
      arrearsDeduction,
      electricityAmount,
    };

    // Persist transaction
    await conn.beginTransaction();
    try {
      await conn.query(
        `INSERT INTO transactions
           (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, breakdown)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'Success', 'Vend', ?)`,
        [reference, customer.id, meterNo, amount, kwh, token, JSON.stringify(breakdown)]
      );

      await conn.query(
        'UPDATE customers SET balance = balance + ? WHERE id = ?',
        [electricityAmount, customer.id]
      );

      if (arrearsDeduction > 0) {
        const newArrears = Math.round((customerArrears - arrearsDeduction) * 100) / 100;
        const newStatus = newArrears > 0 ? 'Arrears' : 'Active';
        await conn.query(
          'UPDATE customers SET arrears = ?, status = ? WHERE id = ?',
          [newArrears, newStatus, customer.id]
        );
      }

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, 'iso8583', 'iso8583', NULL)`,
        [
          'ISO8583_VEND',
          JSON.stringify({ reference, meterNo, amount, kwh }),
        ]
      );

      await conn.commit();

      logger.info('ISO 8583 vend successful', { reference, meterNo, kwh, amount });

      return {
        responseCode: '00', // Approved
        '37': reference,     // Retrieval reference number
        '63': token,         // Token in field 63
        kwh,
        amount,
        meterNo,
        customerName: customer.name,
      };
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } finally {
    conn.release();
  }
}

// ===========================================================================
// Handle MTI 0400 — Reversal Request
// ===========================================================================
async function handleReversalRequest(fields) {
  const originalRef = fields['37'] || fields.reference;

  if (!originalRef) {
    return { responseCode: '12', message: 'Missing original reference (field 37)' };
  }

  const conn = await pool.getConnection();
  try {
    const [transactions] = await conn.query(
      'SELECT * FROM transactions WHERE reference = ? LIMIT 1',
      [originalRef]
    );

    if (transactions.length === 0) {
      return { responseCode: '25', message: `Transaction ${originalRef} not found` };
    }

    const txn = transactions[0];

    if (txn.status === 'Reversed') {
      return { responseCode: '94', message: 'Transaction already reversed' };
    }

    const breakdown = typeof txn.breakdown === 'string'
      ? JSON.parse(txn.breakdown)
      : txn.breakdown || {};

    const electricityAmount = parseFloat(breakdown.electricityAmount || 0);
    const arrearsDeduction = parseFloat(breakdown.arrearsDeduction || 0);
    const reversalRef = generateReference();

    await conn.beginTransaction();
    try {
      // Mark original as reversed
      await conn.query(
        `UPDATE transactions SET status = 'Reversed', reversal_reason = 'ISO8583 reversal', reversed_at = NOW() WHERE id = ?`,
        [txn.id]
      );

      // Reverse customer balance
      if (txn.customer_id) {
        await conn.query(
          'UPDATE customers SET balance = balance - ? WHERE id = ?',
          [electricityAmount, txn.customer_id]
        );

        if (arrearsDeduction > 0) {
          await conn.query(
            "UPDATE customers SET arrears = arrears + ?, status = 'Arrears' WHERE id = ?",
            [arrearsDeduction, txn.customer_id]
          );
        }
      }

      // Create reversal record
      await conn.query(
        `INSERT INTO transactions
           (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, breakdown)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'Success', 'Reversal', ?)`,
        [
          reversalRef,
          txn.customer_id,
          txn.meter_no,
          txn.amount,
          txn.kwh,
          JSON.stringify({
            originalReference: txn.reference,
            reason: 'ISO8583 reversal',
            reversedElectricity: electricityAmount,
            reversedArrears: arrearsDeduction,
          }),
        ]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, 'iso8583', 'iso8583', NULL)`,
        [
          'ISO8583_REVERSAL',
          JSON.stringify({ originalReference: txn.reference, reversalRef }),
        ]
      );

      await conn.commit();

      logger.info('ISO 8583 reversal successful', { originalReference: txn.reference, reversalRef });

      return {
        responseCode: '00',
        '37': reversalRef,
        originalReference: txn.reference,
        message: 'Reversal successful',
      };
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } finally {
    conn.release();
  }
}

// ===========================================================================
// Handle MTI 0800 — Network Management / Echo Test
// ===========================================================================
async function handleEchoRequest(fields) {
  return {
    responseCode: '00',
    message: 'Echo response',
    timestamp: new Date().toISOString(),
    ...fields,
  };
}

// ===========================================================================
// startISO8583Server — Launch the TCP server
// ===========================================================================
function startISO8583Server(port = 8583) {
  const server = net.createServer((socket) => {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info(`ISO 8583: Client connected from ${remoteAddr}`);

    let buffer = Buffer.alloc(0);

    socket.on('data', async (data) => {
      // Accumulate data in buffer
      buffer = Buffer.concat([buffer, data]);

      // Need at least 4 bytes for the MTI
      if (buffer.length < 4) return;

      try {
        const message = parseISO8583(buffer);
        buffer = Buffer.alloc(0); // Clear buffer after parsing

        logger.info('ISO 8583: Message received', {
          mti: message.mti,
          fields: message.fields,
          remoteAddr,
        });

        let responseFields;
        let responseMTI;

        switch (message.mti) {
          case '0200': {
            // Financial Transaction (Vend)
            responseMTI = '0210';
            responseFields = await handleVendRequest(message.fields);
            break;
          }

          case '0400': {
            // Reversal
            responseMTI = '0410';
            responseFields = await handleReversalRequest(message.fields);
            break;
          }

          case '0800': {
            // Echo / Network Management
            responseMTI = '0810';
            responseFields = await handleEchoRequest(message.fields);
            break;
          }

          default: {
            responseMTI = message.mti.slice(0, 2) + '10';
            responseFields = {
              responseCode: '12',
              message: `Unknown MTI: ${message.mti}`,
            };
            logger.warn(`ISO 8583: Unknown MTI ${message.mti}`, { remoteAddr });
          }
        }

        const responseBuffer = buildISO8583(responseMTI, responseFields);

        logger.info('ISO 8583: Sending response', {
          mti: responseMTI,
          responseCode: responseFields.responseCode,
          remoteAddr,
        });

        socket.write(responseBuffer);
      } catch (err) {
        logger.error('ISO 8583: Processing error', {
          error: err.message,
          stack: err.stack,
          remoteAddr,
        });

        // Send error response
        const errorResponse = buildISO8583('0210', {
          responseCode: '96', // System malfunction
          message: 'Processing error',
        });
        socket.write(errorResponse);
      }
    });

    socket.on('error', (err) => {
      logger.error(`ISO 8583: Socket error from ${remoteAddr}`, {
        error: err.message,
      });
    });

    socket.on('close', () => {
      logger.info(`ISO 8583: Client disconnected: ${remoteAddr}`);
    });
  });

  server.on('error', (err) => {
    logger.error('ISO 8583: Server error', { error: err.message, stack: err.stack });
  });

  server.listen(port, () => {
    logger.info(`ISO 8583 switching server listening on port ${port}`);
  });

  return server;
}

module.exports = {
  startISO8583Server,
  parseISO8583,
  buildISO8583,
};
