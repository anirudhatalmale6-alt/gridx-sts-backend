const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { verifyToken, requireRole } = require('../middleware/auth');
const {
  getUserPermissions,
  setPermission,
  getDefaultPermissions,
  RESOURCES,
  ACTIONS,
} = require('../services/permissionService');

// All permission routes require authentication + ADMIN role
router.use(verifyToken);
router.use(requireRole('ADMIN'));

// ===========================================================================
// GET /defaults/:role — get default permissions for a role
// ===========================================================================
router.get('/defaults/:role', (req, res) => {
  try {
    const { role } = req.params;
    const defaults = getDefaultPermissions(role);

    if (!defaults) {
      return res.status(404).json({
        success: false,
        message: `No default permissions found for role "${role}". Valid roles: ADMIN, SUPERVISOR, OPERATOR, VIEWER.`,
      });
    }

    return res.json({
      success: true,
      role: role.toUpperCase(),
      permissions: defaults,
      resources: RESOURCES,
      actions: ACTIONS,
    });
  } catch (err) {
    logger.error('permissions/defaults/:role failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch default permissions.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ===========================================================================
// GET /:userId — get all permissions for a specific user
// ===========================================================================
router.get('/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);

    if (isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID.',
      });
    }

    const permissions = await getUserPermissions(userId);

    if (permissions === null) {
      return res.status(404).json({
        success: false,
        message: `User with ID ${userId} not found.`,
      });
    }

    return res.json({
      success: true,
      userId,
      permissions,
      resources: RESOURCES,
      actions: ACTIONS,
    });
  } catch (err) {
    logger.error('permissions/:userId GET failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user permissions.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ===========================================================================
// PUT /:userId — set permissions for a specific user
// Body: { permissions: [{ resource, action, allowed }] }
// ===========================================================================
router.put('/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);

    if (isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID.',
      });
    }

    const { permissions } = req.body;

    if (!Array.isArray(permissions) || permissions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Body must contain a non-empty "permissions" array of {resource, action, allowed} objects.',
      });
    }

    // Validate each permission entry
    const errors = [];
    for (let i = 0; i < permissions.length; i++) {
      const p = permissions[i];
      if (!p.resource || !p.action || p.allowed === undefined) {
        errors.push(`Entry ${i}: "resource", "action", and "allowed" are required.`);
        continue;
      }
      if (!RESOURCES.includes(p.resource)) {
        errors.push(`Entry ${i}: Invalid resource "${p.resource}".`);
      }
      if (!ACTIONS.includes(p.action)) {
        errors.push(`Entry ${i}: Invalid action "${p.action}".`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors in permissions array.',
        errors,
      });
    }

    // Apply each permission
    const results = [];
    for (const p of permissions) {
      await setPermission(userId, p.resource, p.action, !!p.allowed);
      results.push({ resource: p.resource, action: p.action, allowed: !!p.allowed });
    }

    logger.info(`Permissions updated for user ${userId} by admin ${req.user.username}`, {
      userId,
      count: results.length,
      admin: req.user.username,
    });

    return res.json({
      success: true,
      message: `${results.length} permission(s) updated for user ${userId}.`,
      applied: results,
    });
  } catch (err) {
    logger.error('permissions/:userId PUT failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to update user permissions.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

module.exports = router;
