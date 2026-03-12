const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { verifyToken } = require('../middleware/auth');

// All dashboard routes require authentication
router.use(verifyToken);

// GET /api/v1/dashboard/kpis
router.get('/kpis', dashboardController.getKPIs);

// GET /api/v1/dashboard/recent-transactions
router.get('/recent-transactions', dashboardController.getRecentTransactions);

// GET /api/v1/dashboard/sales-trend
router.get('/sales-trend', dashboardController.getSalesTrend);

module.exports = router;
