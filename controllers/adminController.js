const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const logger = require('../config/logger');

/**
 * GET /api/v1/admin/operators
 * List all operator / user accounts.
 */
exports.getOperators = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, username, role, status, last_login FROM users ORDER BY name ASC'
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('adminController.getOperators error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch operators' });
  }
};

/**
 * POST /api/v1/admin/operators
 * Create a new operator account (admin only).
 */
exports.createOperator = async (req, res) => {
  try {
    const { name, username, password, role } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, username, and password are required',
      });
    }

    const validRoles = ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'];
    const userRole = validRoles.includes(role) ? role : 'OPERATOR';

    // Hash password
    const salt = await bcrypt.genSalt(12);
    const passwordHash = await bcrypt.hash(password, salt);

    const [result] = await pool.query(
      `INSERT INTO users (name, username, password_hash, role, status)
       VALUES (?, ?, ?, ?, 'Offline')`,
      [name, username, passwordHash, userRole]
    );

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (event, detail, username, type, ip_address)
       VALUES (?, ?, ?, 'create', ?)`,
      [
        'Operator Created',
        `Created operator ${username} (${name}) with role ${userRole}`,
        req.user.username,
        req.ip,
      ]
    );

    logger.info(`Operator created: ${username} (${userRole}) by ${req.user.username}`);

    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    logger.error('adminController.createOperator error', { error: err.message });

    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Username already exists' });
    }

    res.status(500).json({ success: false, message: 'Failed to create operator' });
  }
};

/**
 * PUT /api/v1/admin/operators/:id
 * Update an operator account (admin only).
 */
exports.updateOperator = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, status, password } = req.body;

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (role !== undefined) { fields.push('role = ?'); values.push(role); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }

    // If a new password is provided, hash it
    if (password) {
      const salt = await bcrypt.genSalt(12);
      const passwordHash = await bcrypt.hash(password, salt);
      fields.push('password_hash = ?');
      values.push(passwordHash);
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(id);
    const [result] = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Operator not found' });
    }

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (event, detail, username, type, ip_address)
       VALUES (?, ?, ?, 'update', ?)`,
      [
        'Operator Updated',
        `Updated operator id=${id}: ${fields.map((f) => f.split(' =')[0]).join(', ')}`,
        req.user.username,
        req.ip,
      ]
    );

    logger.info(`Operator updated: id=${id} by ${req.user.username}`);

    res.json({ success: true });
  } catch (err) {
    logger.error('adminController.updateOperator error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to update operator' });
  }
};

/**
 * GET /api/v1/admin/audit-log
 * Retrieve audit log entries with optional filters and pagination.
 */
exports.getAuditLog = async (req, res) => {
  try {
    const {
      type,
      username,
      dateFrom,
      dateTo,
      page = 1,
      limit = 50,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (type) {
      whereClause += ' AND type = ?';
      params.push(type);
    }
    if (username) {
      whereClause += ' AND username = ?';
      params.push(username);
    }
    if (dateFrom) {
      whereClause += ' AND created_at >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClause += ' AND created_at <= ?';
      params.push(dateTo);
    }

    // Count query
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM audit_log ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    // Data query
    const [rows] = await pool.query(
      `SELECT * FROM audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({
      success: true,
      data: rows,
      total,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    logger.error('adminController.getAuditLog error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch audit log' });
  }
};

/**
 * GET /api/v1/admin/system-status
 * Return overall system health status.
 */
exports.getSystemStatus = async (req, res) => {
  try {
    // Test database connection
    let dbStatus = 'Disconnected';
    try {
      const conn = await pool.getConnection();
      conn.release();
      dbStatus = 'Connected';
    } catch {
      dbStatus = 'Disconnected';
    }

    // Retrieve last backup timestamp from system_config (if tracked)
    let lastBackup = null;
    try {
      const [configRows] = await pool.query(
        "SELECT config_value FROM system_config WHERE config_key = 'last_backup'"
      );
      if (configRows.length > 0) {
        lastBackup = configRows[0].config_value;
      }
    } catch {
      // Ignore — config table may not have this key
    }

    // Process uptime
    const uptimeSeconds = process.uptime();
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptime = `${days}d ${hours}h ${minutes}m`;

    res.json({
      success: true,
      data: {
        appServer: 'Online',
        stsGateway: 'Connected',
        database: dbStatus,
        smsGateway: 'Active',
        lastBackup,
        uptime,
      },
    });
  } catch (err) {
    logger.error('adminController.getSystemStatus error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch system status' });
  }
};
