const logger = require('../config/logger');

/**
 * Global error-handler middleware.
 *
 * Must be registered AFTER all routes:
 *   app.use(errorHandler);
 *
 * Handles known error types with appropriate status codes
 * and returns a consistent JSON envelope.
 */
function errorHandler(err, req, res, _next) {
  // --- Determine status code and public message based on error type ----------

  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Internal server error';

  // Validation errors (e.g. express-validator, Joi, Mongoose)
  if (err.name === 'ValidationError' || err.type === 'ValidationError') {
    statusCode = 400;
    message = err.message || 'Validation failed';
  }

  // Unauthorized (e.g. express-jwt, passport)
  if (err.name === 'UnauthorizedError' || err.type === 'UnauthorizedError') {
    statusCode = 401;
    message = err.message || 'Authentication required';
  }

  // JWT-specific errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token has expired';
  }

  // Forbidden
  if (err.name === 'ForbiddenError' || err.type === 'ForbiddenError') {
    statusCode = 403;
    message = err.message || 'Forbidden';
  }

  // Not found
  if (err.name === 'NotFoundError' || err.type === 'NotFoundError') {
    statusCode = 404;
    message = err.message || 'Resource not found';
  }

  // Conflict (e.g. duplicate key)
  if (err.name === 'ConflictError' || err.code === 'ER_DUP_ENTRY') {
    statusCode = 409;
    message = err.message || 'Resource already exists';
  }

  // MySQL-specific errors
  if (err.code === 'ER_BAD_FIELD_ERROR') {
    statusCode = 400;
    message = 'Invalid field in request';
  }

  // --- Log ----------------------------------------------------------------

  if (statusCode >= 500) {
    logger.error(`${statusCode} ${req.method} ${req.originalUrl} — ${message}`, {
      stack: err.stack,
      body: req.body,
      params: req.params,
      query: req.query,
    });
  } else {
    logger.warn(`${statusCode} ${req.method} ${req.originalUrl} — ${message}`);
  }

  // --- Respond ------------------------------------------------------------

  const response = {
    error: true,
    message,
  };

  // Include stack trace only in development
  if (process.env.NODE_ENV !== 'production') {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
