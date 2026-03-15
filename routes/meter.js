/**
 * GRIDx STS Backend — Meter Communication Routes
 *
 * Two route sets:
 *   1. meterFacingRouter — ESP32 firmware endpoints (no JWT, mounted at root)
 *   2. default export    — Dashboard/admin endpoints (JWT auth, mounted at /api/v1/meter)
 */

const { Router } = require('express');
const {
  registerMeter,
  handlePowerData,
  handleEnergyData,
  handleCellularInfo,
  handleLoadControl,
  handleTokenInfo,
  handleCreditTransfer,
  listMeters,
  getMeterDetail,
  sendCommand,
  sendToken,
  getTokenQueue
} = require('../controllers/meterController');

// ============================================================================
//  METER-FACING ENDPOINTS (No JWT — called by ESP32 firmware via SIM800)
//  Mounted at the server root level (NOT under /api/v1)
// ============================================================================

const meterFacingRouter = Router();

// Meter registration
meterFacingRouter.post('/meters/getAccessToken', registerMeter);

// Telemetry ingestion endpoints (match firmware api.cpp exactly)
meterFacingRouter.post('/meterPower/MeterLog/:DRN',       handlePowerData);
meterFacingRouter.post('/meterEnergy/MeterLog/:DRN',      handleEnergyData);
meterFacingRouter.post('/meterCellNetwork/MeterLog/:DRN', handleCellularInfo);
meterFacingRouter.post('/meterLoadControl/MeterLog/:DRN', handleLoadControl);
meterFacingRouter.post('/meterSTSTokesInfo/MeterLog/:DRN', handleTokenInfo);
meterFacingRouter.post('/credit/MeterLog/:DRN',           handleCreditTransfer);

// Relay event logging (match firmware api.cpp: POST /meterRelayEvents/MeterLog/:DRN)
const { receiveRelayEvents } = require('../controllers/relayEventController');
meterFacingRouter.post('/meterRelayEvents/MeterLog/:DRN', receiveRelayEvents);

// ============================================================================
//  DASHBOARD-FACING ENDPOINTS (JWT auth required)
//  Mounted under /api/v1/meter in server.js
// ============================================================================

const dashboardRouter = Router();

// List all meters with latest readings
dashboardRouter.get('/list', listMeters);

// Token delivery queue
dashboardRouter.get('/token-queue', getTokenQueue);

// Meter detail
dashboardRouter.get('/:drn', getMeterDetail);

// Send command to meter
dashboardRouter.post('/:drn/command', sendCommand);

// Queue token for delivery to meter
dashboardRouter.post('/:drn/send-token', sendToken);

module.exports = dashboardRouter;
module.exports.meterFacingRouter = meterFacingRouter;
