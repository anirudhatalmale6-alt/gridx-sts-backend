const express = require('express');
const router = express.Router();
const healthController = require('../controllers/healthController');
const { verifyToken } = require('../middleware/auth');

// POST - receives data from meter (no auth - meter uses its own API key)
router.post('/:drn', healthController.receiveHealthData);

// GET - requires auth (for web dashboard)
router.get('/:drn', verifyToken, healthController.getLatestHealth);
router.get('/:drn/history', verifyToken, healthController.getHealthHistory);

module.exports = router;
