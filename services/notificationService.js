const pool = require('../config/database');
const logger = require('../config/logger');

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

// ===========================================================================
// sendSMS — Send SMS via Africa's Talking API
// ===========================================================================
async function sendSMS(phoneNumber, message) {
  const conn = await pool.getConnection();
  try {
    const sysConfig = await getSystemConfig(conn);

    const apiKey = sysConfig.africastalking_api_key;
    const username = sysConfig.africastalking_username;
    const senderId = sysConfig.africastalking_sender_id || 'GRIDx';

    if (!apiKey || !username) {
      logger.warn('SMS not configured: Africa\'s Talking API key or username missing in system_config');
      return { success: false, message: 'SMS not configured' };
    }

    // Build form-encoded body for Africa's Talking
    const params = new URLSearchParams();
    params.append('username', username);
    params.append('to', phoneNumber);
    params.append('message', message);
    params.append('from', senderId);

    const response = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'apiKey': apiKey,
      },
      body: params.toString(),
    });

    const result = await response.json();

    logger.info('SMS sent via Africa\'s Talking', {
      phoneNumber,
      statusCode: response.status,
      result,
    });

    // Record notification in database
    await conn.query(
      `INSERT INTO notifications (type, recipient, subject, body, status, provider_response, created_at)
       VALUES ('sms', ?, 'SMS', ?, ?, ?, NOW())`,
      [
        phoneNumber,
        message,
        response.ok ? 'sent' : 'failed',
        JSON.stringify(result),
      ]
    );

    return {
      success: response.ok,
      message: response.ok ? 'SMS sent successfully' : 'SMS sending failed',
      providerResponse: result,
    };
  } catch (err) {
    logger.error('sendSMS failed', { error: err.message, stack: err.stack, phoneNumber });

    // Attempt to log the failure
    try {
      await conn.query(
        `INSERT INTO notifications (type, recipient, subject, body, status, provider_response, created_at)
         VALUES ('sms', ?, 'SMS', ?, 'failed', ?, NOW())`,
        [phoneNumber, message, JSON.stringify({ error: err.message })]
      );
    } catch (logErr) {
      logger.error('Failed to log notification record', { error: logErr.message });
    }

    return { success: false, message: err.message };
  } finally {
    conn.release();
  }
}

// ===========================================================================
// sendEmail — Send email via SMTP (nodemailer)
// ===========================================================================
async function sendEmail(to, subject, body) {
  const conn = await pool.getConnection();
  try {
    const nodemailer = require('nodemailer');
    const sysConfig = await getSystemConfig(conn);

    const smtpHost = sysConfig.smtp_host;
    const smtpPort = parseInt(sysConfig.smtp_port, 10) || 587;
    const smtpUser = sysConfig.smtp_user;
    const smtpPass = sysConfig.smtp_pass;
    const smtpFrom = sysConfig.smtp_from || 'noreply@gridx-meters.com';

    if (!smtpHost || !smtpUser || !smtpPass) {
      logger.warn('Email not configured: SMTP settings missing in system_config');
      return { success: false, message: 'Email not configured' };
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    const mailOptions = {
      from: smtpFrom,
      to,
      subject,
      text: body,
    };

    const info = await transporter.sendMail(mailOptions);

    logger.info('Email sent', {
      to,
      subject,
      messageId: info.messageId,
    });

    // Record notification in database
    await conn.query(
      `INSERT INTO notifications (type, recipient, subject, body, status, provider_response, created_at)
       VALUES ('email', ?, ?, ?, 'sent', ?, NOW())`,
      [to, subject, body, JSON.stringify({ messageId: info.messageId })]
    );

    return {
      success: true,
      message: 'Email sent successfully',
      messageId: info.messageId,
    };
  } catch (err) {
    logger.error('sendEmail failed', { error: err.message, stack: err.stack, to });

    // Attempt to log the failure
    try {
      await conn.query(
        `INSERT INTO notifications (type, recipient, subject, body, status, provider_response, created_at)
         VALUES ('email', ?, ?, ?, 'failed', ?, NOW())`,
        [to, subject, body, JSON.stringify({ error: err.message })]
      );
    } catch (logErr) {
      logger.error('Failed to log notification record', { error: logErr.message });
    }

    return { success: false, message: err.message };
  } finally {
    conn.release();
  }
}

// ===========================================================================
// sendTokenSMS — Send a formatted token purchase SMS
// ===========================================================================
async function sendTokenSMS(phoneNumber, customerName, token, kwh, amount, reference) {
  const message =
    `GRIDx: Your electricity token: ${token}\n` +
    `${kwh} kWh for N$${parseFloat(amount).toFixed(2)}\n` +
    `Keep this message safe.\n` +
    `Ref: ${reference}`;

  logger.info('Sending token SMS', { phoneNumber, customerName, token, kwh, amount, reference });

  return sendSMS(phoneNumber, message);
}

// ===========================================================================
// getNotificationHistory — Query notifications with optional filters
// ===========================================================================
async function getNotificationHistory(filters = {}) {
  const conn = await pool.getConnection();
  try {
    const { type, status, dateFrom, dateTo, page = 1, limit = 20 } = filters;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (type) {
      whereClause += ' AND type = ?';
      params.push(type);
    }

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    if (dateFrom) {
      whereClause += ' AND created_at >= ?';
      params.push(dateFrom);
    }

    if (dateTo) {
      whereClause += ' AND created_at <= ?';
      params.push(dateTo);
    }

    // Get total count
    const [countResult] = await conn.query(
      `SELECT COUNT(*) AS total FROM notifications ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Get paginated data
    const [rows] = await conn.query(
      `SELECT * FROM notifications ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      data: rows,
      total,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      totalPages: Math.ceil(total / limit),
    };
  } catch (err) {
    logger.error('getNotificationHistory failed', { error: err.message, stack: err.stack });
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  sendSMS,
  sendEmail,
  sendTokenSMS,
  getNotificationHistory,
};
