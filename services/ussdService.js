const express = require('express');
const router = express.Router();
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
// POST /ussd/callback — Handle USSD session callbacks
// ===========================================================================
router.post('/ussd/callback', async (req, res) => {
  const { sessionId, serviceCode, phoneNumber, text } = req.body;

  logger.info('USSD callback received', { sessionId, serviceCode, phoneNumber, text });

  const conn = await pool.getConnection();
  try {
    let response = '';

    // Parse the USSD text input — levels are separated by *
    const parts = (text || '').split('*').filter(Boolean);
    const level = parts.length;

    // -----------------------------------------------------------------------
    // Level 0 — Main menu (first dial, empty text)
    // -----------------------------------------------------------------------
    if (level === 0) {
      response =
        'CON Welcome to GRIDx Electricity Vending\n' +
        '1. Buy Electricity\n' +
        '2. Check Balance\n' +
        '3. Last Token';
    }

    // -----------------------------------------------------------------------
    // Option 1 — Buy Electricity
    // -----------------------------------------------------------------------
    else if (parts[0] === '1') {
      if (level === 1) {
        // Step 1: Ask for meter number
        response = 'CON Enter your meter number:';
      } else if (level === 2) {
        // Step 2: Ask for amount
        response = 'CON Enter amount (N$):';
      } else if (level === 3) {
        // Step 3: Process vend
        const meterNo = parts[1];
        const amount = parseFloat(parts[2]);

        if (!amount || amount <= 0) {
          response = 'END Invalid amount. Please dial again.';
        } else {
          // Look up customer
          const [customers] = await conn.query(
            'SELECT * FROM customers WHERE meter_no = ? LIMIT 1',
            [meterNo]
          );

          if (customers.length === 0) {
            response = `END Meter number ${meterNo} not found. Please check and try again.`;
          } else {
            const customer = customers[0];

            // Look up tariff blocks
            const [blocks] = await conn.query(
              'SELECT * FROM tariff_blocks WHERE tariff_group_code = ? ORDER BY range_start ASC',
              [customer.tariff_group]
            );

            if (blocks.length === 0) {
              response = 'END Tariff configuration error. Please contact support.';
            } else {
              // Get system config for charges
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

              // Calculate VAT and electricity amount
              const vatAmount = Math.round(((amount - deductions) * (vatRate / (100 + vatRate))) * 100) / 100;
              const electricityAmount = Math.round((amount - deductions - vatAmount) * 100) / 100;

              if (electricityAmount <= 0) {
                response = 'END Amount too low after deductions. Please try a higher amount.';
              } else {
                // Calculate kWh and generate token
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

                  await conn.query(
                    `INSERT INTO audit_log (event, detail, username, type, ip_address)
                     VALUES (?, ?, 'ussd', 'vend', NULL)`,
                    [
                      'USSD_TOKEN_GENERATED',
                      JSON.stringify({ reference, meterNo, amount, kwh, phoneNumber }),
                    ]
                  );

                  await conn.commit();

                  response =
                    `END Token: ${token}\n` +
                    `${kwh} kWh purchased\n` +
                    `Ref: ${reference}`;

                  logger.info('USSD vend successful', { reference, meterNo, kwh, amount, phoneNumber });
                } catch (txnErr) {
                  await conn.rollback();
                  throw txnErr;
                }
              }
            }
          }
        }
      } else {
        response = 'END Invalid option. Dial again.';
      }
    }

    // -----------------------------------------------------------------------
    // Option 2 — Check Balance
    // -----------------------------------------------------------------------
    else if (parts[0] === '2') {
      if (level === 1) {
        response = 'CON Enter your meter number:';
      } else if (level === 2) {
        const meterNo = parts[1];

        const [customers] = await conn.query(
          'SELECT name, balance, arrears FROM customers WHERE meter_no = ? LIMIT 1',
          [meterNo]
        );

        if (customers.length === 0) {
          response = `END Meter number ${meterNo} not found.`;
        } else {
          const c = customers[0];
          const balance = parseFloat(c.balance || 0).toFixed(2);
          const arrears = parseFloat(c.arrears || 0).toFixed(2);
          response = `END Balance: N$${balance}\nArrears: N$${arrears}`;
        }
      } else {
        response = 'END Invalid option. Dial again.';
      }
    }

    // -----------------------------------------------------------------------
    // Option 3 — Last Token
    // -----------------------------------------------------------------------
    else if (parts[0] === '3') {
      if (level === 1) {
        response = 'CON Enter your meter number:';
      } else if (level === 2) {
        const meterNo = parts[1];

        const [transactions] = await conn.query(
          `SELECT token, kwh, created_at
           FROM transactions
           WHERE meter_no = ? AND type = 'Vend' AND status = 'Success'
           ORDER BY created_at DESC
           LIMIT 1`,
          [meterNo]
        );

        if (transactions.length === 0) {
          response = `END No previous token found for meter ${meterNo}.`;
        } else {
          const txn = transactions[0];
          const dateStr = new Date(txn.created_at).toLocaleString('en-NA', {
            dateStyle: 'medium',
            timeStyle: 'short',
          });
          response =
            `END Last token: ${txn.token}\n` +
            `${txn.kwh} kWh\n` +
            `Date: ${dateStr}`;
        }
      } else {
        response = 'END Invalid option. Dial again.';
      }
    }

    // -----------------------------------------------------------------------
    // Default — invalid option
    // -----------------------------------------------------------------------
    else {
      response = 'END Invalid option. Dial again.';
    }

    // USSD gateway expects a plain text response with correct Content-Type
    res.set('Content-Type', 'text/plain');
    return res.send(response);
  } catch (err) {
    logger.error('USSD callback failed', {
      error: err.message,
      stack: err.stack,
      sessionId,
      phoneNumber,
      text,
    });

    res.set('Content-Type', 'text/plain');
    return res.send('END An error occurred. Please try again later.');
  } finally {
    conn.release();
  }
});

module.exports = router;
