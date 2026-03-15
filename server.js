require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const logger = require('./config/logger');

// Route imports
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const vendingRoutes = require('./routes/vending');
const customersRoutes = require('./routes/customers');
const transactionsRoutes = require('./routes/transactions');
const vendorsRoutes = require('./routes/vendors');
const tariffsRoutes = require('./routes/tariffs');
const reportsRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');
const engineeringRoutes = require('./routes/engineering');
const batchesRoutes = require('./routes/batches');
const commissionsRoutes = require('./routes/commissions');
const mapRoutes = require('./routes/map');
const notificationsRoutes = require('./routes/notifications');
const receiptsRoutes = require('./routes/receipts');
const permissionsRoutes = require('./routes/permissions');
const healthRoutes = require('./routes/health');
const relayEventsRoutes = require('./routes/relayEvents');
const ussdRouter = require('./services/ussdService');
const meterDashboardRoutes = require('./routes/meter');
const { meterFacingRouter } = require('./routes/meter');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust first proxy (Nginx reverse proxy)
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Security headers
app.use(helmet());

// CORS configuration
const allowedOrigins = [
  'https://p.gridx-meters.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

// Merge any extra origins supplied via CORS_ORIGIN env var
if (process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .forEach((origin) => {
      if (!allowedOrigins.includes(origin)) {
        allowedOrigins.push(origin);
      }
    });
}

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests with no origin (e.g. server-to-server, curl, mobile)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — general API limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
  },
});
app.use('/api', apiLimiter);

// Request logging
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'GRIDx STS Backend is running',
    timestamp: new Date().toISOString(),
    version: require('./package.json').version,
  });
});

// API v1 routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/vending', vendingRoutes);
app.use('/api/v1/customers', customersRoutes);
app.use('/api/v1/transactions', transactionsRoutes);
app.use('/api/v1/vendors', vendorsRoutes);
app.use('/api/v1/tariffs', tariffsRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/reports', reportsRoutes);
app.use('/api/v1/engineering', engineeringRoutes);
app.use('/api/v1/batches', batchesRoutes);
app.use('/api/v1/commissions', commissionsRoutes);
app.use('/api/v1/map', mapRoutes);
app.use('/api/v1/notifications', notificationsRoutes);
app.use('/api/v1/receipts', receiptsRoutes);
app.use('/api/v1/permissions', permissionsRoutes);
app.use('/api/v1/meter-health', healthRoutes);
app.use('/api/v1/relay-events', relayEventsRoutes);
app.use('/api/v1', ussdRouter);
app.use('/api/v1/meter', meterDashboardRoutes);   // Dashboard-facing meter endpoints (JWT auth)

// Meter-facing endpoints mounted at root (no JWT — ESP32 firmware uses API key)
// These MUST match the exact paths the firmware POSTs to:
//   POST /meters/getAccessToken
//   POST /meterPower/MeterLog/:DRN
//   POST /meterEnergy/MeterLog/:DRN
//   POST /meterCellNetwork/MeterLog/:DRN
//   POST /meterLoadControl/MeterLog/:DRN
//   POST /meterSTSTokesInfo/MeterLog/:DRN
//   POST /credit/MeterLog/:DRN
app.use(meterFacingRouter);

// Start ISO 8583 switching server (third-party vendor integration)
if (process.env.ISO8583_ENABLED === 'true') {
  const { startISO8583Server } = require('./services/iso8583Service');
  const iso8583Port = parseInt(process.env.ISO8583_PORT || '8583', 10);
  startISO8583Server(iso8583Port);
}

// 404 handler for unmatched routes
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
  });

  // CORS origin rejection
  if (err.message && err.message.includes('not allowed by CORS')) {
    return res.status(403).json({
      success: false,
      message: err.message,
    });
  }

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message,
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  logger.info(`GRIDx STS Backend started on port ${PORT}`, {
    environment: process.env.NODE_ENV || 'development',
    port: PORT,
  });
  logger.info(`Health check available at http://localhost:${PORT}/api/health`);
});

module.exports = app;
