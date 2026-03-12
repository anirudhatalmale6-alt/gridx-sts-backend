const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All admin routes require authentication
router.use(verifyToken);

// GET /api/v1/admin/operators
router.get('/operators', adminController.getOperators);

// POST /api/v1/admin/operators (admin only)
router.post('/operators', requireRole('ADMIN'), adminController.createOperator);

// PUT /api/v1/admin/operators/:id (admin only)
router.put('/operators/:id', requireRole('ADMIN'), adminController.updateOperator);

// GET /api/v1/admin/audit-log
router.get('/audit-log', adminController.getAuditLog);

// GET /api/v1/admin/system-status
router.get('/system-status', adminController.getSystemStatus);

module.exports = router;
