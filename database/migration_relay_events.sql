-- ============================================================================
-- Migration: Relay Events Table
-- Description: Stores relay state/control change events sent from meters
-- ============================================================================

CREATE TABLE IF NOT EXISTS meter_relay_events (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  drn             VARCHAR(20) NOT NULL,
  relay_index     TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0=Mains, 1=Geyser',
  entry_type      TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0=STATE_CHANGE, 1=CONTROL_CHANGE',
  state           TINYINT UNSIGNED DEFAULT NULL COMMENT '1=ON, 0=OFF',
  control         TINYINT UNSIGNED DEFAULT NULL COMMENT '1=ENABLED, 0=DISABLED',
  reason_code     TINYINT UNSIGNED DEFAULT 0 COMMENT '0=UNKNOWN,1=MANUAL,2=CREDIT,3=POWER_LIMIT,4=SCHEDULED,5=REMOTE,6=STARTUP,7=TAMPER,8=OVERCURRENT',
  reason_text     VARCHAR(64) DEFAULT '' COMMENT 'Human-readable reason string',
  trigger_type    TINYINT UNSIGNED DEFAULT 0,
  meter_timestamp DATETIME DEFAULT NULL COMMENT 'Timestamp from the meter',
  received_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_mre_drn (drn),
  INDEX idx_mre_received (received_at),
  INDEX idx_mre_drn_received (drn, received_at),
  INDEX idx_mre_relay (drn, relay_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
