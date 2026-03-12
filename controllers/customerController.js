const pool = require('../config/database');
const logger = require('../config/logger');

// ===========================================================================
// GET / — list all customers with pagination and optional filters
// ===========================================================================
exports.getAll = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    // Optional filters
    const { area, tariffGroup, status } = req.query;
    const conditions = [];
    const params = [];

    if (area) {
      conditions.push('area = ?');
      params.push(area);
    }
    if (tariffGroup) {
      conditions.push('tariff_group = ?');
      params.push(tariffGroup);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    // Count total matching rows
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM customers ${whereClause}`,
      params
    );
    const total = countRows[0].total;

    // Fetch page of data
    const [data] = await pool.query(
      `SELECT * FROM customers ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.json({
      success: true,
      data,
      total,
      page,
      limit,
    });
  } catch (err) {
    logger.error('customerController.getAll failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch customers.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// GET /search?q=... — search customers by name, meter_no, or account_no
// ===========================================================================
exports.search = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query parameter "q" is required.',
      });
    }

    const like = `%${q}%`;

    const [rows] = await pool.query(
      `SELECT * FROM customers
       WHERE name LIKE ? OR meter_no LIKE ? OR account_no LIKE ?
       ORDER BY name ASC
       LIMIT 50`,
      [like, like, like]
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    logger.error('customerController.search failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Customer search failed.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// GET /:id — get a single customer by id (int) or account_no (string)
// ===========================================================================
exports.getById = async (req, res) => {
  try {
    const { id } = req.params;

    let query;
    let param;

    // If the param looks like an integer, search by id; otherwise by account_no
    if (/^\d+$/.test(id)) {
      query = 'SELECT * FROM customers WHERE id = ? LIMIT 1';
      param = parseInt(id, 10);
    } else {
      query = 'SELECT * FROM customers WHERE account_no = ? LIMIT 1';
      param = id;
    }

    const [rows] = await pool.query(query, [param]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Customer "${id}" not found.`,
      });
    }

    return res.json({
      success: true,
      data: rows[0],
    });
  } catch (err) {
    logger.error('customerController.getById failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch customer.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
};

// ===========================================================================
// POST / — create a new customer
// ===========================================================================
exports.create = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const {
      name,
      meter_no,
      area,
      tariff_group,
      sgc,
      key_revision,
      meter_make,
      meter_model,
      balance,
      arrears,
      status,
      phone,
      address,
      gps_lat,
      gps_lng,
    } = req.body;

    // Validate required fields
    if (!name || !meter_no || !area || !tariff_group) {
      return res.status(400).json({
        success: false,
        message: 'name, meter_no, area, and tariff_group are required.',
      });
    }

    // Check for duplicate meter_no
    const [existing] = await conn.query(
      'SELECT id FROM customers WHERE meter_no = ? LIMIT 1',
      [meter_no]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: `A customer with meter number "${meter_no}" already exists.`,
      });
    }

    // Generate account_no: ACC-{year}-{6-digit sequence}
    const year = new Date().getFullYear();
    const [maxRow] = await conn.query(
      `SELECT account_no FROM customers
       WHERE account_no LIKE ?
       ORDER BY account_no DESC LIMIT 1`,
      [`ACC-${year}-%`]
    );

    let seq = 1;
    if (maxRow.length > 0) {
      // Extract the sequence from the last account_no  (ACC-YYYY-NNNNNN)
      const parts = maxRow[0].account_no.split('-');
      const lastSeq = parseInt(parts[2], 10);
      if (!isNaN(lastSeq)) {
        seq = lastSeq + 1;
      }
    }
    const account_no = `ACC-${year}-${String(seq).padStart(6, '0')}`;

    await conn.beginTransaction();

    try {
      const [result] = await conn.query(
        `INSERT INTO customers
           (account_no, name, meter_no, area, tariff_group, sgc, key_revision,
            meter_make, meter_model, balance, arrears, status, phone, address, gps_lat, gps_lng)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          account_no,
          name,
          meter_no,
          area,
          tariff_group,
          sgc || null,
          key_revision || null,
          meter_make || null,
          meter_model || null,
          parseFloat(balance) || 0,
          parseFloat(arrears) || 0,
          status || 'Active',
          phone || null,
          address || null,
          gps_lat != null ? parseFloat(gps_lat) : null,
          gps_lng != null ? parseFloat(gps_lng) : null,
        ]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'create', ?)`,
        [
          'CUSTOMER_CREATED',
          JSON.stringify({
            id: result.insertId,
            account_no,
            name,
            meter_no,
            area,
            tariff_group,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Customer created: ${account_no} (${name})`, {
        id: result.insertId,
        account_no,
        meter_no,
      });

      return res.status(201).json({
        success: true,
        id: result.insertId,
        account_no,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('customerController.create failed', { error: err.message, stack: err.stack });

    // Handle duplicate entry errors from MySQL
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'A customer with this meter number or account number already exists.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to create customer.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};

// ===========================================================================
// PUT /:id — update an existing customer
// ===========================================================================
exports.update = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const customerId = parseInt(req.params.id, 10);
    if (isNaN(customerId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid customer ID.',
      });
    }

    // Check existence
    const [existing] = await conn.query(
      'SELECT * FROM customers WHERE id = ? LIMIT 1',
      [customerId]
    );
    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Customer with ID ${customerId} not found.`,
      });
    }

    // Build dynamic SET clause from allowed fields
    const allowedFields = [
      'name', 'meter_no', 'area', 'tariff_group', 'sgc', 'key_revision',
      'meter_make', 'meter_model', 'balance', 'arrears', 'status',
      'phone', 'address', 'gps_lat', 'gps_lng',
    ];

    const setClauses = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        setClauses.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided for update.',
      });
    }

    values.push(customerId);

    await conn.beginTransaction();

    try {
      await conn.query(
        `UPDATE customers SET ${setClauses.join(', ')} WHERE id = ?`,
        values
      );

      // Audit log
      const changedFields = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          changedFields[field] = req.body[field];
        }
      }

      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, ?, 'update', ?)`,
        [
          'CUSTOMER_UPDATED',
          JSON.stringify({
            id: customerId,
            account_no: existing[0].account_no,
            changes: changedFields,
          }),
          req.user ? req.user.username : 'system',
          req.ip || null,
        ]
      );

      await conn.commit();

      logger.info(`Customer updated: ${existing[0].account_no}`, {
        id: customerId,
        changes: changedFields,
      });

      return res.json({
        success: true,
        message: `Customer ${existing[0].account_no} updated successfully.`,
      });
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('customerController.update failed', { error: err.message, stack: err.stack });

    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'Update would create a duplicate meter number or account number.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to update customer.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  } finally {
    conn.release();
  }
};
