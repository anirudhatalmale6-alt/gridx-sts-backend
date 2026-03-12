const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const logger = require('../config/logger');

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'change-me-in-production';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'change-me-refresh-secret';

/**
 * Hash a refresh token for safe storage in the database.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * POST /api/v1/auth/login
 *
 * Validate username/password against the users table, issue JWT access
 * and refresh tokens, update last_login and status, and log the event.
 */
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    // --- Validation ---
    if (!username || !password) {
      return res.status(400).json({
        error: true,
        message: 'Username and password are required.',
      });
    }

    // --- Lookup user ---
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE username = ? LIMIT 1',
      [username]
    );

    if (rows.length === 0) {
      logger.warn(`Login failed — unknown username: ${username}`);
      return res.status(401).json({
        error: true,
        message: 'Invalid username or password.',
      });
    }

    const user = rows[0];

    // --- Verify password ---
    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) {
      logger.warn(`Login failed — wrong password for user: ${username}`);
      return res.status(401).json({
        error: true,
        message: 'Invalid username or password.',
      });
    }

    // --- Generate tokens ---
    const tokenPayload = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    };

    const token = jwt.sign(tokenPayload, ACCESS_TOKEN_SECRET, {
      expiresIn: '24h',
    });

    const refreshToken = jwt.sign(tokenPayload, REFRESH_TOKEN_SECRET, {
      expiresIn: '7d',
    });

    // --- Store refresh token hash, update status & last_login ---
    const refreshTokenHash = hashToken(refreshToken);
    await pool.query(
      `UPDATE users
         SET refresh_token = ?, status = 'Online', last_login = NOW()
       WHERE id = ?`,
      [refreshTokenHash, user.id]
    );

    // --- Audit log ---
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
       VALUES (?, 'LOGIN', ?, ?, NOW())`,
      [user.id, `User ${username} logged in`, req.ip]
    );

    logger.info(`User logged in: ${username} (id=${user.id})`);

    return res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
      },
    });
  } catch (err) {
    logger.error('Login error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: true,
      message: 'Internal server error.',
    });
  }
};

/**
 * POST /api/v1/auth/logout
 *
 * Clear the refresh token, set status to Offline, and add an audit log entry.
 * Requires authentication (verifyToken middleware).
 */
exports.logout = async (req, res) => {
  try {
    const userId = req.user.id;

    // Clear refresh token and set status to Offline
    await pool.query(
      `UPDATE users SET refresh_token = NULL, status = 'Offline' WHERE id = ?`,
      [userId]
    );

    // Audit log
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, details, ip_address, created_at)
       VALUES (?, 'LOGOUT', ?, ?, NOW())`,
      [userId, `User ${req.user.username} logged out`, req.ip]
    );

    logger.info(`User logged out: ${req.user.username} (id=${userId})`);

    return res.json({ success: true });
  } catch (err) {
    logger.error('Logout error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: true,
      message: 'Internal server error.',
    });
  }
};

/**
 * POST /api/v1/auth/refresh
 *
 * Verify the supplied refresh token, check its hash against the stored value,
 * and issue a new access token.
 */
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: true,
        message: 'Refresh token is required.',
      });
    }

    // --- Verify the JWT signature ---
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    } catch (err) {
      logger.warn('Refresh token verification failed', { error: err.message });
      return res.status(401).json({
        error: true,
        message: 'Invalid or expired refresh token.',
      });
    }

    // --- Verify against stored hash ---
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: true,
        message: 'User not found.',
      });
    }

    const user = rows[0];
    const storedHash = user.refresh_token;
    const incomingHash = hashToken(refreshToken);

    if (!storedHash || storedHash !== incomingHash) {
      logger.warn(`Refresh token hash mismatch for user id=${decoded.id}`);
      return res.status(401).json({
        error: true,
        message: 'Refresh token has been revoked.',
      });
    }

    // --- Issue new access token ---
    const tokenPayload = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    };

    const token = jwt.sign(tokenPayload, ACCESS_TOKEN_SECRET, {
      expiresIn: '24h',
    });

    logger.info(`Access token refreshed for user: ${user.username}`);

    return res.json({ token });
  } catch (err) {
    logger.error('Refresh token error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: true,
      message: 'Internal server error.',
    });
  }
};

/**
 * GET /api/v1/auth/me
 *
 * Return the authenticated user's full profile (from DB, not just the JWT payload).
 * Requires authentication (verifyToken middleware).
 */
exports.getProfile = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, username, email, role, status, last_login, created_at
       FROM users WHERE id = ? LIMIT 1`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'User not found.',
      });
    }

    return res.json({ user: rows[0] });
  } catch (err) {
    logger.error('Get profile error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      error: true,
      message: 'Internal server error.',
    });
  }
};
