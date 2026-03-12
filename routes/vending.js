const express = require('express');
const router = express.Router();
const vendingController = require('../controllers/vendingController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All vending routes require authentication
router.use(verifyToken);

// POST /api/v1/vending/generate-token
router.post('/generate-token', vendingController.generateToken);

// POST /api/v1/vending/reverse/:transactionId
router.post(
  '/reverse/:transactionId',
  requireRole('ADMIN', 'SUPERVISOR'),
  vendingController.reverseTransaction
);

// GET /api/v1/vending/reprint/:transactionId
router.get('/reprint/:transactionId', vendingController.reprintToken);

module.exports = router;
