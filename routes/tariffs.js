const express = require('express');
const router = express.Router();
const tariffController = require('../controllers/tariffController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All tariff routes require authentication
router.use(verifyToken);

// GET /api/v1/tariffs
router.get('/', tariffController.getAll);

// GET /api/v1/tariffs/config
router.get('/config', tariffController.getConfig);

// PUT /api/v1/tariffs/:id (admin only)
router.put('/:id', requireRole('ADMIN'), tariffController.update);

module.exports = router;
