const pool = require('../config/database');
const logger = require('../config/logger');

/**
 * GET /api/v1/vendors
 * List all vendors.
 */
exports.getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, code, name, location, status,
             commission_rate AS commissionRate,
             total_sales     AS totalSales,
             transaction_count AS transactions,
             balance,
             operator_name   AS operator,
             phone
      FROM vendors ORDER BY name ASC
    `);

    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('vendorController.getAll error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch vendors' });
  }
};

/**
 * GET /api/v1/vendors/:id
 * Retrieve a single vendor by id.
 */
exports.getById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM vendors WHERE id = ?', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    logger.error('vendorController.getById error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch vendor' });
  }
};

/**
 * POST /api/v1/vendors
 * Create a new vendor (admin only).
 */
exports.create = async (req, res) => {
  try {
    const { code, name, location, status, commission_rate, operator_name, phone } = req.body;

    if (!code || !name) {
      return res.status(400).json({ success: false, message: 'Vendor code and name are required' });
    }

    const [result] = await pool.query(
      `INSERT INTO vendors (code, name, location, status, commission_rate, operator_name, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code, name, location || null, status || 'Active', commission_rate || 2.0, operator_name || null, phone || null]
    );

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (event, detail, username, type, ip_address)
       VALUES (?, ?, ?, 'create', ?)`,
      [
        'Vendor Created',
        `Created vendor ${code} — ${name}`,
        req.user.username,
        req.ip,
      ]
    );

    logger.info(`Vendor created: ${code} — ${name} by ${req.user.username}`);

    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    logger.error('vendorController.create error', { error: err.message });

    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Vendor code already exists' });
    }

    res.status(500).json({ success: false, message: 'Failed to create vendor' });
  }
};

/**
 * PUT /api/v1/vendors/:id
 * Update a vendor (admin only).
 */
exports.update = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, location, status, commission_rate, operator_name, phone } = req.body;

    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (location !== undefined) { fields.push('location = ?'); values.push(location); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }
    if (commission_rate !== undefined) { fields.push('commission_rate = ?'); values.push(commission_rate); }
    if (operator_name !== undefined) { fields.push('operator_name = ?'); values.push(operator_name); }
    if (phone !== undefined) { fields.push('phone = ?'); values.push(phone); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(id);
    const [result] = await pool.query(
      `UPDATE vendors SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (event, detail, username, type, ip_address)
       VALUES (?, ?, ?, 'update', ?)`,
      [
        'Vendor Updated',
        `Updated vendor id=${id}: ${fields.join(', ')}`,
        req.user.username,
        req.ip,
      ]
    );

    logger.info(`Vendor updated: id=${id} by ${req.user.username}`);

    res.json({ success: true });
  } catch (err) {
    logger.error('vendorController.update error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to update vendor' });
  }
};

/**
 * POST /api/v1/vendors/:id/batch/open
 * Open a new vending batch for a vendor.
 */
exports.openBatch = async (req, res) => {
  try {
    const { id } = req.params;
    const batchId = `BATCH-${Date.now()}`;

    // Verify vendor exists
    const [vendor] = await pool.query('SELECT id, code, name FROM vendors WHERE id = ?', [id]);
    if (vendor.length === 0) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (event, detail, username, type, ip_address)
       VALUES (?, ?, ?, 'system', ?)`,
      [
        'Batch Opened',
        `Opened batch ${batchId} for vendor ${vendor[0].code} — ${vendor[0].name}`,
        req.user.username,
        req.ip,
      ]
    );

    logger.info(`Batch opened: ${batchId} for vendor ${vendor[0].code} by ${req.user.username}`);

    res.json({ success: true, batchId });
  } catch (err) {
    logger.error('vendorController.openBatch error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to open batch' });
  }
};

/**
 * POST /api/v1/vendors/:id/batch/close
 * Close the current vending batch for a vendor.
 */
exports.closeBatch = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify vendor exists
    const [vendor] = await pool.query('SELECT id, code, name FROM vendors WHERE id = ?', [id]);
    if (vendor.length === 0) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (event, detail, username, type, ip_address)
       VALUES (?, ?, ?, 'system', ?)`,
      [
        'Batch Closed',
        `Closed batch for vendor ${vendor[0].code} — ${vendor[0].name}`,
        req.user.username,
        req.ip,
      ]
    );

    logger.info(`Batch closed for vendor ${vendor[0].code} by ${req.user.username}`);

    res.json({ success: true });
  } catch (err) {
    logger.error('vendorController.closeBatch error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to close batch' });
  }
};
