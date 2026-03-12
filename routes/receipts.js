const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const logger = require('../config/logger');
const { verifyToken } = require('../middleware/auth');
const { generateReceipt, generateThermalReceipt } = require('../services/receiptService');

// All receipt routes require authentication
router.use(verifyToken);

// ---------------------------------------------------------------------------
// Helper — look up a transaction with customer info by reference
// ---------------------------------------------------------------------------
async function lookupTransaction(transactionRef) {
  const [rows] = await pool.query(
    `SELECT t.*, c.name AS customer_name, c.account_no, c.area, c.tariff_group,
            v.name AS vendor_name, u.username AS operator_name
     FROM transactions t
     LEFT JOIN customers c ON c.id = t.customer_id
     LEFT JOIN vendors v ON v.id = t.vendor_id
     LEFT JOIN users u ON u.id = t.operator_id
     WHERE t.reference = ?
     LIMIT 1`,
    [transactionRef]
  );

  if (rows.length === 0) return null;

  const txn = rows[0];

  // Parse breakdown JSON
  if (typeof txn.breakdown === 'string') {
    try {
      txn.breakdown = JSON.parse(txn.breakdown);
    } catch (_) {
      // leave as-is
    }
  }

  return txn;
}

// ===========================================================================
// GET /:transactionRef — generate and stream PDF receipt (inline)
// ===========================================================================
router.get('/:transactionRef', async (req, res) => {
  try {
    const { transactionRef } = req.params;
    const txn = await lookupTransaction(transactionRef);

    if (!txn) {
      return res.status(404).json({
        success: false,
        message: `Transaction "${transactionRef}" not found.`,
      });
    }

    const pdfBuffer = await generateReceipt(txn);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${transactionRef}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);
  } catch (err) {
    logger.error('receipts/:transactionRef failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to generate receipt.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ===========================================================================
// GET /:transactionRef/download — generate and download PDF receipt (attachment)
// ===========================================================================
router.get('/:transactionRef/download', async (req, res) => {
  try {
    const { transactionRef } = req.params;
    const txn = await lookupTransaction(transactionRef);

    if (!txn) {
      return res.status(404).json({
        success: false,
        message: `Transaction "${transactionRef}" not found.`,
      });
    }

    const pdfBuffer = await generateReceipt(txn);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${transactionRef}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);
  } catch (err) {
    logger.error('receipts/:transactionRef/download failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to generate receipt for download.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ===========================================================================
// GET /:transactionRef/thermal — thermal printer receipt format
// ===========================================================================
router.get('/:transactionRef/thermal', async (req, res) => {
  try {
    const { transactionRef } = req.params;
    const txn = await lookupTransaction(transactionRef);

    if (!txn) {
      return res.status(404).json({
        success: false,
        message: `Transaction "${transactionRef}" not found.`,
      });
    }

    const pdfBuffer = await generateThermalReceipt(txn);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="thermal-receipt-${transactionRef}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);
  } catch (err) {
    logger.error('receipts/:transactionRef/thermal failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to generate thermal receipt.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
