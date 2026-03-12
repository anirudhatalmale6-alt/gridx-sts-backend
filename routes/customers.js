const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All customer routes require authentication
router.use(verifyToken);

// GET /api/v1/customers/search?q=...
router.get('/search', customerController.search);

// GET /api/v1/customers
router.get('/', customerController.getAll);

// GET /api/v1/customers/:id
router.get('/:id', customerController.getById);

// POST /api/v1/customers
router.post(
  '/',
  requireRole('ADMIN', 'SUPERVISOR'),
  customerController.create
);

// PUT /api/v1/customers/:id
router.put(
  '/:id',
  requireRole('ADMIN', 'SUPERVISOR'),
  customerController.update
);

module.exports = router;
