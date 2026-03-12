const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middleware/auth');

// POST /api/v1/auth/login
router.post('/login', authController.login);

// POST /api/v1/auth/logout (requires auth)
router.post('/logout', verifyToken, authController.logout);

// POST /api/v1/auth/refresh
router.post('/refresh', authController.refreshToken);

// GET /api/v1/auth/me (requires auth)
router.get('/me', verifyToken, authController.getProfile);

module.exports = router;
