-- ============================================================================
-- GRIDx STS Backend — Migration V3: ESP32 Meter Communication
-- ============================================================================
-- Adds tables for direct meter-to-server communication, token delivery queue,
-- and meter telemetry storage. Matches the GRIDx ESP32 firmware API protocol.
--
-- Run after migration_v2.sql:
--   mysql -u gridX-sql-admin -p gridx_sts < database/migration_v3_meter.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. meter_registry — tracks all GRIDx ESP32 meters that have communicated
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_registry (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  drn             VARCHAR(20) NOT NULL UNIQUE,       -- 13-digit Decoder Reference Number
  api_key         VARCHAR(255),                       -- Access token issued to meter
  phone           VARCHAR(20),                        -- SIM phone number (from cellular info)
  imei            VARCHAR(20),                        -- IMEI of SIM800 modem
  operator_name   VARCHAR(50),                        -- GSM network operator (e.g. MTC Namibia)
  firmware_ver    VARCHAR(20),                        -- Firmware version if reported
  customer_id     INT,                                -- Link to existing customers table
  status          ENUM('Online','Offline','Tampered','Unregistered') DEFAULT 'Unregistered',
  last_seen       DATETIME,
  registered_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_mr_drn (drn),
  INDEX idx_mr_status (status),
  INDEX idx_mr_customer (customer_id),

  CONSTRAINT fk_mr_customer
    FOREIGN KEY (customer_id) REFERENCES customers(id)
    ON UPDATE CASCADE ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- 2. meter_telemetry — stores all telemetry POSTs from meters
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_telemetry (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  drn         VARCHAR(20) NOT NULL,
  type        ENUM('power','energy','cellular','load','token_info','credit') NOT NULL,
  data_json   JSON NOT NULL,                          -- Raw JSON array from meter
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_mt_drn (drn),
  INDEX idx_mt_type (type),
  INDEX idx_mt_received (received_at),
  INDEX idx_mt_drn_type (drn, type, received_at)
);

-- ---------------------------------------------------------------------------
-- 3. token_delivery_queue — tokens waiting to be pushed to meters via API
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_delivery_queue (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  drn             VARCHAR(20) NOT NULL,
  token           VARCHAR(30) NOT NULL,               -- 20-digit STS token
  transaction_id  INT,                                -- Link to transactions table
  status          ENUM('pending','delivered','accepted','rejected','expired') DEFAULT 'pending',
  delivery_method ENUM('api','sms','ble','manual') DEFAULT 'api',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at    DATETIME,
  accepted_at     DATETIME,
  rejected_at     DATETIME,
  retry_count     INT DEFAULT 0,
  max_retries     INT DEFAULT 10,
  error_message   TEXT,

  INDEX idx_tdq_drn (drn),
  INDEX idx_tdq_status (status),
  INDEX idx_tdq_drn_status (drn, status),

  CONSTRAINT fk_tdq_transaction
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
    ON UPDATE CASCADE ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- 4. meter_commands — commands queued for delivery to meters
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_commands (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  drn             VARCHAR(20) NOT NULL,
  command_type    VARCHAR(30) NOT NULL,               -- relay_on, relay_off, geyser_on, reset, etc.
  command_json    JSON NOT NULL,                      -- GRIDx JSON keys: {"mc":1,"ms":1}
  requested_by    INT,                                -- User who issued command
  status          ENUM('queued','delivered','acknowledged') DEFAULT 'queued',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at    DATETIME,

  INDEX idx_mc_drn (drn),
  INDEX idx_mc_status (status),

  CONSTRAINT fk_mc_user
    FOREIGN KEY (requested_by) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- 5. meter_power_latest — latest power readings per meter (for quick dashboard)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_power_latest (
  drn             VARCHAR(20) PRIMARY KEY,
  current_a       DECIMAL(8,3),
  voltage_v       DECIMAL(8,3),
  active_w        DECIMAL(10,3),
  reactive_var    DECIMAL(10,3),
  apparent_va     DECIMAL(10,3),
  temperature_c   DECIMAL(6,2),
  frequency_hz    DECIMAL(6,3),
  power_factor    DECIMAL(5,4),
  meter_epoch     BIGINT,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 6. meter_energy_latest — latest energy/credit per meter
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_energy_latest (
  drn               VARCHAR(20) PRIMARY KEY,
  active_energy_wh  DECIMAL(14,2),
  reactive_energy_wh DECIMAL(14,2),
  credit_kwh        DECIMAL(12,2),
  tamper_flag       TINYINT DEFAULT 0,
  tamper_timestamp  BIGINT DEFAULT 0,
  reset_count       INT DEFAULT 0,
  meter_epoch       BIGINT,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 7. Add meter communication config to system_config
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO system_config (config_key, config_value) VALUES
  ('meterApiEnabled', 'true'),
  ('meterApiBaseUrl', 'http://p.gridx-meters.com'),
  ('meterTokenDeliveryMethod', 'api'),
  ('meterPowerDataInterval', '900000'),
  ('meterEnergyDataInterval', '180000'),
  ('meterCellularInfoInterval', '43200000'),
  ('meterTokenInfoInterval', '4800000'),
  ('meterLoadStatusInterval', '900000');
