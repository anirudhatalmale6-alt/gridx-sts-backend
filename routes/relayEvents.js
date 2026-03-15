const express = require('express');
const router = express.Router();
const relayEventController = require('../controllers/relayEventController');
const { verifyToken } = require('../middleware/auth');

// GET - dashboard queries (JWT auth required)
router.get('/:drn', verifyToken, relayEventController.getRelayEvents);
router.get('/:drn/summary', verifyToken, relayEventController.getRelayEventSummary);

module.exports = router;
