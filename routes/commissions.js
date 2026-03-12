const express = require('express');
const router = express.Router();
const commissionController = require('../controllers/commissionController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All commission routes require authentication
router.use(verifyToken);

// POST /api/v1/commissions/calculate (ADMIN only)
router.post(
  '/calculate',
  requireRole('ADMIN'),
  commissionController.calculateCommissions
);

// GET /api/v1/commissions/summary
router.get('/summary', commissionController.getCommissionSummary);

// GET /api/v1/commissions
router.get('/', commissionController.getCommissions);

// PUT /api/v1/commissions/:id/approve (ADMIN only)
router.put(
  '/:id/approve',
  requireRole('ADMIN'),
  commissionController.approveCommission
);

// PUT /api/v1/commissions/:id/paid (ADMIN only)
router.put(
  '/:id/paid',
  requireRole('ADMIN'),
  commissionController.markCommissionPaid
);

module.exports = router;
