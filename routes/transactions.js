const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { verifyToken } = require('../middleware/auth');

// All transaction routes require authentication
router.use(verifyToken);

// GET /api/v1/transactions
router.get('/', transactionController.getAll);

// GET /api/v1/transactions/export
router.get('/export', transactionController.export);

// GET /api/v1/transactions/:id
router.get('/:id', transactionController.getById);

module.exports = router;
