const express = require('express');
const router = express.Router();
const vendorController = require('../controllers/vendorController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All vendor routes require authentication
router.use(verifyToken);

// GET /api/v1/vendors
router.get('/', vendorController.getAll);

// GET /api/v1/vendors/:id
router.get('/:id', vendorController.getById);

// POST /api/v1/vendors (admin only)
router.post('/', requireRole('ADMIN'), vendorController.create);

// PUT /api/v1/vendors/:id (admin only)
router.put('/:id', requireRole('ADMIN'), vendorController.update);

// POST /api/v1/vendors/:id/batch/open
router.post('/:id/batch/open', vendorController.openBatch);

// POST /api/v1/vendors/:id/batch/close
router.post('/:id/batch/close', vendorController.closeBatch);

module.exports = router;
