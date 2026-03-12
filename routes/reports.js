const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { verifyToken } = require('../middleware/auth');

// All report routes require authentication
router.use(verifyToken);

// GET /api/v1/reports/:type (daily, weekly, monthly, vendor, revenue, compliance)
router.get('/:type', reportController.generate);

// GET /api/v1/reports/:type/export
router.get('/:type/export', reportController.export);

module.exports = router;
