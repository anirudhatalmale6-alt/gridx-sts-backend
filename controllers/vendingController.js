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
  return digits.replace(/(.{4})/g, '$1-').slice(0, 24); // 24 chars with dashes
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
// Helper — calculate kWh from step tariff blocks for a given electricity amount
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

  return Math.round(totalKwh * 100) / 100; // round to 2 decimal places
}

// ===========================================================================
// POST /generate-token
// ===========================================================================
exports.generateToken = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { meterNo, amount } = req.body;

    if (!meterNo || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'meterNo and a positive amount are required.',
      });
    }

    // 1. Look up customer by meter number
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

    // 2. Look up tariff group and blocks
    const [tariffGroups] = await conn.query(
      'SELECT * FROM tariff_groups WHERE code = ? AND status = ? LIMIT 1',
      [customer.tariff_group, 'Active']
    );

    if (tariffGroups.length === 0) {
      return res.status(400).json({
        success: false,
        message: `Tariff group "${customer.tariff_group}" not found or inactive.`,
      });
    }

    const [blocks] = await conn.query(
      'SELECT * FROM tariff_blocks WHERE tariff_group_code = ? ORDER BY range_start ASC',
      [customer.tariff_group]
    );

    if (blocks.length === 0) {
      return res.status(400).json({
        success: false,
        message: `No tariff blocks configured for group "${customer.tariff_group}".`,
      });
    }

    // 3. Get system configuration
    const sysConfig = await getSystemConfig(conn);

    const vatRate = parseFloat(sysConfig.vatRate || '0');
    const fixedCharge = parseFloat(sysConfig.fixedCharge || '0');
    const relLevy = parseFloat(sysConfig.relLevy || '0');

    // 4. Calculate deductions
    let deductions = fixedCharge + relLevy;
    let arrearsDeduction = 0;

    const customerArrears = parseFloat(customer.arrears) || 0;
    if (customerArrears > 0) {
      // Deduct up to 20% of the tendered amount toward arrears
      arrearsDeduction = Math.min(customerArrears, amount * 0.2);
      arrearsDeduction = Math.round(arrearsDeduction * 100) / 100;
      deductions += arrearsDeduction;
    }

    // 5. Calculate VAT and electricity amount
    const vatAmount = Math.round(((amount - deductions) * (vatRate / (100 + vatRate))) * 100) / 100;
    const electricityAmount = Math.round((amount - deductions - vatAmount) * 100) / 100;

    if (electricityAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount is too low after deductions. No electricity units can be generated.',
      });
    }

    // 6. Calculate kWh from step tariff blocks
    const kwh = calculateKwhFromBlocks(blocks, electricityAmount);

    // 7. Generate token and reference
    const token = generateStsToken();
    const reference = generateReference();

    // 8. Determine vendor_id
    let vendorId = null;
    if (req.user && req.user.vendor_id) {
      vendorId = req.user.vendor_id;
    } else {
      // Default to first active vendor
      const [vendors] = await conn.query(
        "SELECT id FROM vendors WHERE status = 'Active' ORDER BY id ASC LIMIT 1"
      );
      if (vendors.length > 0) {
        vendorId = vendors[0].id;
      }
    }

    // 9. Build breakdown JSON
    const breakdown = {
      amountTendered: parseFloat(amount),
      vat: vatAmount,
      fixedCharge,
      relLevy,
      arrearsDeduction,
      electricityAmount,
    };

    // 10. Start transaction
    await conn.beginTransaction();

    try {
      // Insert transaction record
      await conn.query(
        `INSERT INTO transactions
           (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, breakdown)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Success', 'Vend', ?)`,
        [
          reference,
          customer.id,
          meterNo,
          amount,
          kwh,
          token,
          req.user ? req.user.id : null,
          vendorId,
          JSON.stringify(breakdown),
        ]
      );

      // Update customer balance
      await conn.query(
        'UPDATE customers SET balance = balance + ? WHERE id = ?',
        [electricityAmount, customer.id]
      );

      // Handle arrears deduction
      if (arrearsDeduction > 0) {
        const newArrears = Math.round((customerArrears - arrearsDeduction) * 100) / 100;
        const newStatus = newArrears > 0 ? 'Arrears' : 'Active';
        await conn.query(
          'UPDATE customers SET arrears = ?, status = ? WHERE id = ?',
          [newArrears, newStatus, customer.id]
        );
      }

      // Update vendor totals
      if (vendorId) {
        await conn.query(
          'UPDATE vendors SET total_sales = total_sales + ?, transaction_count = transaction_count + 1 WHERE id = ?',
          [amount, vendorId]
        );
      }

      // Audit log entry
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'vend', ?)`,
        [
          'TOKEN_GENERATED',
          JSON.stringify({
            reference,
            meterNo,
            amount,
            kwh,
            customerName: customer.name,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      // Auto-queue token for delivery to meter via API (if meter is registered)
      try {
        const [meterReg] = await conn.query(
          'SELECT id FROM meter_registry WHERE drn = ? LIMIT 1',
          [meterNo]
        );
        if (meterReg.length > 0) {
          const [lastTx] = await conn.query(
            'SELECT id FROM transactions WHERE reference = ? LIMIT 1',
            [reference]
          );
          const txId = lastTx.length > 0 ? lastTx[0].id : null;
          await conn.query(
            `INSERT INTO token_delivery_queue (drn, token, transaction_id, delivery_method)
             VALUES (?, ?, ?, 'api')`,
            [meterNo, token, txId]
          );
          logger.info(`Token auto-queued for meter delivery: ${meterNo}`);
        }
      } catch (queueErr) {
        // Non-fatal — token was still generated successfully
        logger.warn('Failed to auto-queue token for meter delivery', { error: queueErr.message });
      }

      await conn.commit();

      logger.info(`Token generated: ${reference} | Meter: ${meterNo} | kWh: ${kwh}`, {
        reference,
        meterNo,
        kwh,
        amount,
      });

      return res.status(201).json({
        success: true,
        token,
        reference,
        kwh,
        breakdown,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('generateToken failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to generate token.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// POST /reverse/:transactionId
// ===========================================================================
exports.reverseTransaction = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { transactionId } = req.params; // this is the reference string
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'A reversal reason is required.',
      });
    }

    // 1. Find the original transaction by reference
    const [transactions] = await conn.query(
      'SELECT * FROM transactions WHERE reference = ? LIMIT 1',
      [transactionId]
    );

    if (transactions.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Transaction with reference "${transactionId}" not found.`,
      });
    }

    const txn = transactions[0];

    if (txn.status === 'Reversed') {
      return res.status(400).json({
        success: false,
        message: 'This transaction has already been reversed.',
      });
    }

    // 2. Parse the original breakdown
    const breakdown = typeof txn.breakdown === 'string'
      ? JSON.parse(txn.breakdown)
      : txn.breakdown || {};

    const electricityAmount = parseFloat(breakdown.electricityAmount || 0);
    const arrearsDeduction = parseFloat(breakdown.arrearsDeduction || 0);

    // 3. Generate reversal reference
    const reversalRef = generateReference();

    await conn.beginTransaction();

    try {
      // Mark original transaction as reversed
      await conn.query(
        `UPDATE transactions
         SET status = 'Reversed',
             reversal_reason = ?,
             reversed_by = ?,
             reversed_at = NOW()
         WHERE id = ?`,
        [reason, req.user.id, txn.id]
      );

      // Reverse customer balance
      if (txn.customer_id) {
        await conn.query(
          'UPDATE customers SET balance = balance - ? WHERE id = ?',
          [electricityAmount, txn.customer_id]
        );

        // Reverse arrears deduction
        if (arrearsDeduction > 0) {
          await conn.query(
            "UPDATE customers SET arrears = arrears + ?, status = 'Arrears' WHERE id = ?",
            [arrearsDeduction, txn.customer_id]
          );
        }
      }

      // Create reversal transaction record
      await conn.query(
        `INSERT INTO transactions
           (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, breakdown)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'Success', 'Reversal', ?)`,
        [
          reversalRef,
          txn.customer_id,
          txn.meter_no,
          txn.amount,
          txn.kwh,
          req.user.id,
          txn.vendor_id,
          JSON.stringify({
            originalReference: txn.reference,
            reason,
            reversedElectricity: electricityAmount,
            reversedArrears: arrearsDeduction,
          }),
        ]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'reversal', ?)`,
        [
          'TRANSACTION_REVERSED',
          JSON.stringify({
            originalReference: txn.reference,
            reversalRef,
            reason,
            amount: txn.amount,
          }),
          req.user.username,
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Transaction reversed: ${txn.reference} -> ${reversalRef}`, {
        originalReference: txn.reference,
        reversalRef,
        reason,
      });

      return res.json({
        success: true,
        reversalRef,
        message: `Transaction ${txn.reference} has been reversed.`,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('reverseTransaction failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to reverse transaction.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// GET /reprint/:transactionId
// ===========================================================================
exports.reprintToken = async (req, res) => {
  try {
    const { transactionId } = req.params; // reference string

    const [transactions] = await pool.query(
      `SELECT t.*, c.name AS customer_name, c.account_no, c.area, c.tariff_group
       FROM transactions t
       LEFT JOIN customers c ON c.id = t.customer_id
       WHERE t.reference = ?
       LIMIT 1`,
      [transactionId]
    );

    if (transactions.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Transaction with reference "${transactionId}" not found.`,
      });
    }

    const txn = transactions[0];
    const breakdown = typeof txn.breakdown === 'string'
      ? JSON.parse(txn.breakdown)
      : txn.breakdown || {};

    logger.info(`Token reprinted: ${txn.reference}`, {
      reference: txn.reference,
      username: req.user ? req.user.username : 'unknown',
    });

    return res.json({
      success: true,
      token: txn.token,
      reference: txn.reference,
      meterNo: txn.meter_no,
      customerName: txn.customer_name,
      accountNo: txn.account_no,
      area: txn.area,
      tariffGroup: txn.tariff_group,
      amount: txn.amount,
      kwh: txn.kwh,
      status: txn.status,
      type: txn.type,
      breakdown,
      createdAt: txn.created_at,
    });
  } catch (err) {
    logger.error('reprintToken failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve token for reprint.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};
