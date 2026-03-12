const express = require('express');
const router = express.Router();
const engineeringController = require('../controllers/engineeringController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All engineering routes require authentication
router.use(verifyToken);

// POST /api/v1/engineering/engineering-token (ADMIN only)
router.post(
  '/engineering-token',
  requireRole('ADMIN'),
  engineeringController.generateEngineeringToken
);

// POST /api/v1/engineering/free-units (SUPERVISOR only)
router.post(
  '/free-units',
  requireRole('SUPERVISOR'),
  engineeringController.generateFreeUnits
);

// POST /api/v1/engineering/key-change (ADMIN only)
router.post(
  '/key-change',
  requireRole('ADMIN'),
  engineeringController.generateKeyChangeToken
);

// POST /api/v1/engineering/replacement-token (any authenticated user)
router.post(
  '/replacement-token',
  engineeringController.generateReplacementToken
);

module.exports = router;
