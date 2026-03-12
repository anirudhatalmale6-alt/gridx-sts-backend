const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { verifyToken, requireRole } = require('../middleware/auth');

// All notification routes require authentication
router.use(verifyToken);

// GET /api/v1/notifications — list notification history (paginated, filterable)
router.get('/', notificationController.getHistory);

// POST /api/v1/notifications/sms — send ad-hoc SMS (ADMIN only)
router.post('/sms', requireRole('ADMIN'), notificationController.sendSMS);

// POST /api/v1/notifications/token-sms/:transactionId — send token SMS for a transaction
router.post('/token-sms/:transactionId', notificationController.sendTokenSMS);

module.exports = router;
