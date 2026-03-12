const rateLimit = require('express-rate-limit');

/**
 * General rate limiter — applied to all routes.
 *
 * Env vars:
 *   RATE_LIMIT_WINDOW_MS            — window in milliseconds (default: 15 minutes)
 *   RATE_LIMIT_MAX_REQUESTS         — max requests per window   (default: 100)
 */
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  standardHeaders: true, // Return rate-limit info in RateLimit-* headers
  legacyHeaders: false,  // Disable X-RateLimit-* headers
  message: {
    error: true,
    message: 'Too many requests. Please try again later.',
  },
});

/**
 * Auth rate limiter — stricter, applied to login/register routes.
 *
 * Env vars:
 *   REGISTRATION_RATE_LIMIT_MAX_REQUESTS — max requests per window (default: 10)
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.REGISTRATION_RATE_LIMIT_MAX_REQUESTS, 10) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: true,
    message: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
});

module.exports = { generalLimiter, authLimiter };
