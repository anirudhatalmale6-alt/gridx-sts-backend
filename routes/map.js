const express = require('express');
const router = express.Router();
const mapController = require('../controllers/mapController');
const { verifyToken } = require('../middleware/auth');

// All map routes require authentication
router.use(verifyToken);

// GET /api/v1/map/meters — all meters with GPS coordinates
router.get('/meters', mapController.getMeterLocations);

// GET /api/v1/map/meters/:meterNo — single meter detail + recent transactions
router.get('/meters/:meterNo', mapController.getMeterDetail);

// GET /api/v1/map/areas — area-level summary
router.get('/areas', mapController.getAreaSummary);

module.exports = router;
