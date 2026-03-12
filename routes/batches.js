const express = require('express');
const router = express.Router();
const batchController = require('../controllers/batchController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All batch routes require authentication
router.use(verifyToken);

// --- Sales Batches ---

// POST /api/v1/batches/sales
router.post('/sales', batchController.openSalesBatch);

// PUT /api/v1/batches/sales/:id/close (SUPERVISOR only)
router.put(
  '/sales/:id/close',
  requireRole('SUPERVISOR'),
  batchController.closeSalesBatch
);

// GET /api/v1/batches/sales
router.get('/sales', batchController.getSalesBatches);

// GET /api/v1/batches/sales/:id
router.get('/sales/:id', batchController.getSalesBatchDetail);

// PUT /api/v1/batches/sales/:id/reconcile (ADMIN only)
router.put(
  '/sales/:id/reconcile',
  requireRole('ADMIN'),
  batchController.reconcileBatch
);

// --- Banking Batches ---

// POST /api/v1/batches/banking (ADMIN only)
router.post(
  '/banking',
  requireRole('ADMIN'),
  batchController.openBankingBatch
);

// PUT /api/v1/batches/banking/:id (ADMIN only)
router.put(
  '/banking/:id',
  requireRole('ADMIN'),
  batchController.closeBankingBatch
);

// GET /api/v1/batches/banking
router.get('/banking', batchController.getBankingBatches);

module.exports = router;
