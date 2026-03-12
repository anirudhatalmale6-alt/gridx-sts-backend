const pool = require('../config/database');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RESOURCES = [
  'customers',
  'transactions',
  'vendors',
  'tariffs',
  'reports',
  'admin',
  'vending',
  'engineering',
  'batches',
  'commissions',
  'map',
  'notifications',
];

const ACTIONS = ['read', 'create', 'update', 'delete', 'export'];

// ---------------------------------------------------------------------------
// Default permission matrices by role
// ---------------------------------------------------------------------------
const DEFAULT_PERMISSIONS = {
  ADMIN: (() => {
    const perms = {};
    for (const resource of RESOURCES) {
      perms[resource] = {};
      for (const action of ACTIONS) {
        perms[resource][action] = true;
      }
    }
    return perms;
  })(),

  SUPERVISOR: (() => {
    const perms = {};
    for (const resource of RESOURCES) {
      perms[resource] = {};
      for (const action of ACTIONS) {
        // Supervisors can read/export everything, write most things, but NOT user management (admin)
        if (resource === 'admin') {
          perms[resource][action] = action === 'read';
        } else {
          perms[resource][action] = true;
        }
      }
    }
    return perms;
  })(),

  OPERATOR: (() => {
    const perms = {};
    // Operators: read most, write vending/customers only
    const writeAllowed = ['vending', 'customers'];
    for (const resource of RESOURCES) {
      perms[resource] = {};
      for (const action of ACTIONS) {
        if (resource === 'admin') {
          perms[resource][action] = false;
        } else if (action === 'read' || action === 'export') {
          perms[resource][action] = true;
        } else if (writeAllowed.includes(resource)) {
          perms[resource][action] = true;
        } else {
          perms[resource][action] = false;
        }
      }
    }
    return perms;
  })(),

  VIEWER: (() => {
    const perms = {};
    for (const resource of RESOURCES) {
      perms[resource] = {};
      for (const action of ACTIONS) {
        perms[resource][action] = action === 'read';
      }
    }
    return perms;
  })(),
};

// ===========================================================================
// checkPermission — Check if a user has permission for a specific action
// ===========================================================================
async function checkPermission(userId, resource, action) {
  try {
    // 1. Check for explicit user-level permission override
    const [rows] = await pool.query(
      `SELECT allowed FROM user_permissions
       WHERE user_id = ? AND resource = ? AND action = ?
       LIMIT 1`,
      [userId, resource, action]
    );

    if (rows.length > 0) {
      return !!rows[0].allowed;
    }

    // 2. Fall back to role-based defaults
    const [userRows] = await pool.query(
      'SELECT role FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    if (userRows.length === 0) {
      logger.warn(`checkPermission: user ${userId} not found`);
      return false;
    }

    const role = (userRows[0].role || '').toUpperCase();
    const defaults = DEFAULT_PERMISSIONS[role];

    if (!defaults) {
      logger.warn(`checkPermission: unknown role "${role}" for user ${userId}`);
      return false;
    }

    if (defaults[resource] && defaults[resource][action] !== undefined) {
      return defaults[resource][action];
    }

    return false;
  } catch (err) {
    logger.error('checkPermission failed', { error: err.message, stack: err.stack, userId, resource, action });
    return false;
  }
}

// ===========================================================================
// getUserPermissions — Get all permissions for a user as a structured object
// ===========================================================================
async function getUserPermissions(userId) {
  try {
    // Get user role for defaults
    const [userRows] = await pool.query(
      'SELECT role FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    if (userRows.length === 0) {
      return null;
    }

    const role = (userRows[0].role || '').toUpperCase();
    const defaults = DEFAULT_PERMISSIONS[role] || {};

    // Start with role defaults (deep clone)
    const permissions = {};
    for (const resource of RESOURCES) {
      permissions[resource] = {};
      for (const action of ACTIONS) {
        permissions[resource][action] =
          defaults[resource] && defaults[resource][action] !== undefined
            ? defaults[resource][action]
            : false;
      }
    }

    // Override with user-specific permissions
    const [overrides] = await pool.query(
      'SELECT resource, action, allowed FROM user_permissions WHERE user_id = ?',
      [userId]
    );

    for (const row of overrides) {
      if (permissions[row.resource]) {
        permissions[row.resource][row.action] = !!row.allowed;
      }
    }

    return permissions;
  } catch (err) {
    logger.error('getUserPermissions failed', { error: err.message, stack: err.stack, userId });
    throw err;
  }
}

// ===========================================================================
// setPermission — Insert or update a user-level permission override
// ===========================================================================
async function setPermission(userId, resource, action, allowed) {
  const conn = await pool.getConnection();
  try {
    // Validate resource and action
    if (!RESOURCES.includes(resource)) {
      throw new Error(`Invalid resource: "${resource}". Must be one of: ${RESOURCES.join(', ')}`);
    }
    if (!ACTIONS.includes(action)) {
      throw new Error(`Invalid action: "${action}". Must be one of: ${ACTIONS.join(', ')}`);
    }

    await conn.beginTransaction();

    try {
      // UPSERT: insert or update the permission
      await conn.query(
        `INSERT INTO user_permissions (user_id, resource, action, allowed)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
        [userId, resource, action, allowed ? 1 : 0]
      );

      // Audit log
      await conn.query(
        `INSERT INTO audit_log (event, detail, username, type, ip_address)
         VALUES (?, ?, 'system', 'permission', NULL)`,
        [
          'PERMISSION_CHANGED',
          JSON.stringify({
            userId,
            resource,
            action,
            allowed,
          }),
        ]
      );

      await conn.commit();

      logger.info(`Permission set: user=${userId}, ${resource}.${action} = ${allowed}`);

      return true;
    } catch (txnErr) {
      await conn.rollback();
      throw txnErr;
    }
  } catch (err) {
    logger.error('setPermission failed', { error: err.message, stack: err.stack, userId, resource, action });
    throw err;
  } finally {
    conn.release();
  }
}

// ===========================================================================
// getDefaultPermissions — Return the default permission matrix for a role
// ===========================================================================
function getDefaultPermissions(role) {
  const normalized = (role || '').toUpperCase();
  return DEFAULT_PERMISSIONS[normalized] || null;
}

module.exports = {
  checkPermission,
  getUserPermissions,
  setPermission,
  getDefaultPermissions,
  RESOURCES,
  ACTIONS,
};
