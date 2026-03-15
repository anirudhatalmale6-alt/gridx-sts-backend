-- Migration: Add meter_health table for diagnostic data from meters
-- Run this on the gridx_sts database

CREATE TABLE IF NOT EXISTS meter_health (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  drn             VARCHAR(24) NOT NULL,
  health_score    TINYINT UNSIGNED DEFAULT 0,
  uart_errors     INT UNSIGNED DEFAULT 0,
  relay_mismatches INT UNSIGNED DEFAULT 0,
  power_anomalies INT UNSIGNED DEFAULT 0,
  voltage         DECIMAL(8,3) DEFAULT 0,
  current_a       DECIMAL(8,3) DEFAULT 0,
  active_power    DECIMAL(10,3) DEFAULT 0,
  frequency       DECIMAL(6,3) DEFAULT 0,
  power_factor    DECIMAL(4,2) DEFAULT 0,
  temperature     DECIMAL(5,1) DEFAULT 0,
  mains_state     TINYINT DEFAULT 0,
  mains_control   TINYINT DEFAULT 0,
  geyser_state    TINYINT DEFAULT 0,
  geyser_control  TINYINT DEFAULT 0,
  firmware        VARCHAR(20) DEFAULT '',
  uptime_seconds  INT UNSIGNED DEFAULT 0,
  meter_timestamp DATETIME NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_meter_health_drn (drn),
  INDEX idx_meter_health_created (created_at),
  INDEX idx_meter_health_drn_created (drn, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
