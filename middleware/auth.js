const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'change-me-in-production';

/**
 * verifyToken — Express middleware
 *
 * Reads the Authorization header (Bearer <token>), verifies it against
 * ACCESS_TOKEN_SECRET, and attaches the decoded payload to req.user.
 * Returns 401 JSON on missing/invalid token.
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({
      error: true,
      message: 'Access denied. No authorization header provided.',
    });
  }

  // Expect "Bearer <token>"
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: true,
      message: 'Access denied. Malformed authorization header. Expected "Bearer <token>".',
    });
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: true,
        message: 'Access denied. Token has expired.',
      });
    }
    return res.status(401).json({
      error: true,
      message: 'Access denied. Invalid token.',
    });
  }
}

/**
 * requireRole — Higher-order middleware factory
 *
 * Returns middleware that checks whether req.user.role is included
 * in the provided list of allowed roles.
 * Must be used AFTER verifyToken so that req.user is populated.
 *
 * Usage: router.get('/admin', verifyToken, requireRole('admin', 'superadmin'), handler);
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: true,
        message: 'Access denied. Authentication required.',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: true,
        message: `Forbidden. Required role(s): ${roles.join(', ')}. Your role: ${req.user.role}.`,
      });
    }

    next();
  };
}

module.exports = { verifyToken, requireRole };
