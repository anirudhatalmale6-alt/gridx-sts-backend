const pool = require('../config/database');
const logger = require('../config/logger');
const notificationService = require('../services/notificationService');

// ===========================================================================
// GET / — Notification history (paginated, filterable)
// ===========================================================================
exports.getHistory = async (req, res) => {
  try {
    const { type, status, dateFrom, dateTo, page, limit } = req.query;

    const result = await notificationService.getNotificationHistory({
      type,
      status,
      dateFrom,
      dateTo,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
    });

    return res.json({
      success: true,
      data: result.data,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  } catch (err) {
    logger.error('getHistory failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve notification history.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// POST /sms — Send ad-hoc SMS (ADMIN only)
// ===========================================================================
exports.sendSMS = async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Both phone and message are required.',
      });
    }

    // Validate phone number format (basic check)
    const phoneClean = phone.trim();
    if (phoneClean.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format.',
      });
    }

    logger.info('Admin sending ad-hoc SMS', {
      phone: phoneClean,
      username: req.user ? req.user.username : 'unknown',
    });

    const result = await notificationService.sendSMS(phoneClean, message.trim());

    return res.json({
      success: result.success,
      message: result.message,
      providerResponse: result.providerResponse,
    });
  } catch (err) {
    logger.error('sendSMS failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to send SMS.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// POST /token-sms/:transactionId — Send token SMS for a specific transaction
// ===========================================================================
exports.sendTokenSMS = async (req, res) => {
  try {
    const { transactionId } = req.params;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: 'Transaction ID (reference) is required.',
      });
    }

    // Look up the transaction and the associated customer
    const [transactions] = await pool.query(
      `SELECT t.*, c.name AS customer_name, c.phone AS customer_phone
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

    if (!txn.token) {
      return res.status(400).json({
        success: false,
        message: 'No token associated with this transaction (may be a reversal).',
      });
    }

    // Determine phone number — use request body override or customer phone
    const phoneNumber = req.body.phone || txn.customer_phone;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'No phone number available. Provide a phone number in the request body or ensure the customer has a phone on file.',
      });
    }

    logger.info('Sending token SMS for transaction', {
      reference: txn.reference,
      phoneNumber,
      username: req.user ? req.user.username : 'unknown',
    });

    const result = await notificationService.sendTokenSMS(
      phoneNumber,
      txn.customer_name || 'Customer',
      txn.token,
      txn.kwh,
      txn.amount,
      txn.reference
    );

    return res.json({
      success: result.success,
      message: result.message,
      reference: txn.reference,
      sentTo: phoneNumber,
    });
  } catch (err) {
    logger.error('sendTokenSMS failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to send token SMS.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};
