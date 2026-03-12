const pool = require('../config/database');
const logger = require('../config/logger');

/**
 * GET /api/v1/tariffs
 * List all tariff groups with their associated blocks.
 */
exports.getAll = async (req, res) => {
  try {
    // Fetch all tariff groups
    const [groups] = await pool.query(
      'SELECT id, code, name, sgc, meter_count, status FROM tariff_groups ORDER BY code ASC'
    );

    // Fetch all tariff blocks
    const [blocks] = await pool.query(
      `SELECT id, tariff_group_code, name, range_description, range_start, range_end, rate
       FROM tariff_blocks
       ORDER BY tariff_group_code ASC, range_start ASC`
    );

    // Group blocks by tariff_group_code
    const blockMap = {};
    for (const block of blocks) {
      if (!blockMap[block.tariff_group_code]) {
        blockMap[block.tariff_group_code] = [];
      }
      blockMap[block.tariff_group_code].push({
        id: block.id,
        name: block.name,
        rangeDescription: block.range_description,
        rangeStart: block.range_start,
        rangeEnd: block.range_end,
        rate: block.rate,
      });
    }

    // Merge blocks into groups
    const data = groups.map((group) => ({
      id: group.id,
      code: group.code,
      name: group.name,
      sgc: group.sgc,
      meterCount: group.meter_count,
      status: group.status,
      blocks: blockMap[group.code] || [],
    }));

    res.json({ success: true, data });
  } catch (err) {
    logger.error('tariffController.getAll error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch tariffs' });
  }
};

/**
 * GET /api/v1/tariffs/config
 * Retrieve system configuration as a key-value object.
 */
exports.getConfig = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT config_key, config_value FROM system_config');

    const config = {};
    for (const row of rows) {
      config[row.config_key] = row.config_value;
    }

    res.json({ success: true, data: config });
  } catch (err) {
    logger.error('tariffController.getConfig error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch system config' });
  }
};

/**
 * PUT /api/v1/tariffs/:id
 * Update tariff blocks for a given tariff group (admin only).
 * Expects body: { blocks: [{ name, rangeDescription, rangeStart, rangeEnd, rate }] }
 */
exports.update = async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const { id } = req.params;
    const { blocks } = req.body;

    // Look up tariff group by id
    const [groups] = await connection.query(
      'SELECT id, code, name FROM tariff_groups WHERE id = ?',
      [id]
    );

    if (groups.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Tariff group not found' });
    }

    const group = groups[0];

    if (!blocks || !Array.isArray(blocks)) {
      connection.release();
      return res.status(400).json({ success: false, message: 'blocks array is required' });
    }

    await connection.beginTransaction();

    // Delete existing blocks for this tariff group
    await connection.query(
      'DELETE FROM tariff_blocks WHERE tariff_group_code = ?',
      [group.code]
    );

    // Insert new blocks
    for (const block of blocks) {
      await connection.query(
        `INSERT INTO tariff_blocks (tariff_group_code, name, range_description, range_start, range_end, rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          group.code,
          block.name,
          block.rangeDescription || null,
          block.rangeStart || 0,
          block.rangeEnd || null,
          block.rate,
        ]
      );
    }

    await connection.commit();

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (event, detail, username, type, ip_address)
       VALUES (?, ?, ?, 'update', ?)`,
      [
        'Tariff Updated',
        `Updated ${blocks.length} block(s) for tariff group ${group.code} — ${group.name}`,
        req.user.username,
        req.ip,
      ]
    );

    logger.info(`Tariff updated: ${group.code} (${blocks.length} blocks) by ${req.user.username}`);

    connection.release();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    connection.release();
    logger.error('tariffController.update error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to update tariff' });
  }
};
