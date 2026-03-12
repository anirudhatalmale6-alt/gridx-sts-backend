-- ============================================================================
-- GRIDx STS Prepaid Electricity Vending System — Database Schema
-- ============================================================================
-- Run this script against a MySQL 8.x (or MariaDB 10.6+) server.
-- It will DROP existing tables and recreate them from scratch.
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS tariff_blocks;
DROP TABLE IF EXISTS tariff_groups;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS vendors;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS system_config;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- 1. users — operator / admin accounts
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(100)   NOT NULL,
  username        VARCHAR(50)    NOT NULL UNIQUE,
  password_hash   VARCHAR(255)   NOT NULL,
  role            ENUM('ADMIN','SUPERVISOR','OPERATOR','VIEWER') DEFAULT 'OPERATOR',
  status          ENUM('Online','Offline','Suspended')           DEFAULT 'Offline',
  last_login      DATETIME       NULL,
  refresh_token   TEXT           NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. customers — electricity customers
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  account_no      VARCHAR(20)    NOT NULL UNIQUE COMMENT 'e.g. ACC-2019-004521',
  name            VARCHAR(100)   NOT NULL,
  meter_no        VARCHAR(20)    NOT NULL UNIQUE,
  area            VARCHAR(50)    NOT NULL,
  tariff_group    VARCHAR(10)    NOT NULL COMMENT 'R1, R2, C1, etc.',
  sgc             VARCHAR(10)    NULL,
  key_revision    VARCHAR(10)    NULL,
  meter_make      VARCHAR(50)    NULL,
  meter_model     VARCHAR(50)    NULL,
  balance         DECIMAL(12,2)  DEFAULT 0.00,
  arrears         DECIMAL(12,2)  DEFAULT 0.00,
  status          ENUM('Active','Arrears','Suspended','Disconnected') DEFAULT 'Active',
  phone           VARCHAR(20)    NULL,
  address         TEXT           NULL,
  gps_lat         DECIMAL(10,6)  NULL,
  gps_lng         DECIMAL(10,6)  NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_customers_meter_no     (meter_no),
  INDEX idx_customers_area         (area),
  INDEX idx_customers_tariff_group (tariff_group),
  INDEX idx_customers_status       (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. vendors — vending points / shops
-- ---------------------------------------------------------------------------
CREATE TABLE vendors (
  id                INT            AUTO_INCREMENT PRIMARY KEY,
  code              VARCHAR(10)    NOT NULL UNIQUE,
  name              VARCHAR(100)   NOT NULL,
  location          VARCHAR(200)   NULL,
  status            ENUM('Active','Low Balance','Suspended') DEFAULT 'Active',
  commission_rate   DECIMAL(5,2)   DEFAULT 2.00,
  total_sales       DECIMAL(14,2)  DEFAULT 0.00,
  transaction_count INT            DEFAULT 0,
  balance           DECIMAL(12,2)  DEFAULT 0.00,
  operator_name     VARCHAR(100)   NULL,
  phone             VARCHAR(20)    NULL,
  created_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. tariff_groups — tariff categories
-- ---------------------------------------------------------------------------
CREATE TABLE tariff_groups (
  id          INT            AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(10)    NOT NULL UNIQUE,
  name        VARCHAR(100)   NOT NULL,
  sgc         VARCHAR(10)    NULL,
  meter_count INT            DEFAULT 0,
  status      ENUM('Active','Inactive') DEFAULT 'Active',
  created_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. tariff_blocks — stepped pricing blocks within a tariff
-- ---------------------------------------------------------------------------
CREATE TABLE tariff_blocks (
  id                  INT            AUTO_INCREMENT PRIMARY KEY,
  tariff_group_code   VARCHAR(10)    NOT NULL,
  name                VARCHAR(50)    NOT NULL,
  range_description   VARCHAR(50)    NULL COMMENT 'e.g. "0 – 50 kWh"',
  range_start         DECIMAL(10,2)  DEFAULT 0.00,
  range_end           DECIMAL(10,2)  NULL COMMENT 'NULL = unlimited',
  rate                DECIMAL(8,4)   NOT NULL,
  created_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_tariff_blocks_group
    FOREIGN KEY (tariff_group_code) REFERENCES tariff_groups(code)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. transactions — all vending transactions
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  reference       VARCHAR(30)    NOT NULL UNIQUE COMMENT 'e.g. TXN-20260312200247',
  customer_id     INT            NULL,
  meter_no        VARCHAR(20)    NOT NULL,
  amount          DECIMAL(12,2)  NOT NULL,
  kwh             DECIMAL(10,2)  NULL,
  token           VARCHAR(30)    NULL COMMENT '20-digit STS token: XXXX-XXXX-XXXX-XXXX-XXXX',
  operator_id     INT            NULL,
  vendor_id       INT            NULL,
  status          ENUM('Success','Failed','Reversed','Arrears') DEFAULT 'Success',
  type            ENUM('Vend','Reversal','FreeIssue','KeyChange') DEFAULT 'Vend',
  breakdown       JSON           NULL COMMENT 'Stores vat, fixedCharge, relLevy, arrears deduction amounts',
  reversal_reason TEXT           NULL,
  reversed_by     INT            NULL,
  reversed_at     DATETIME       NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_transactions_customer_id (customer_id),
  INDEX idx_transactions_meter_no    (meter_no),
  INDEX idx_transactions_status      (status),
  INDEX idx_transactions_created_at  (created_at),
  INDEX idx_transactions_operator_id (operator_id),
  INDEX idx_transactions_vendor_id   (vendor_id),

  CONSTRAINT fk_transactions_customer
    FOREIGN KEY (customer_id) REFERENCES customers(id)
    ON UPDATE CASCADE ON DELETE SET NULL,

  CONSTRAINT fk_transactions_operator
    FOREIGN KEY (operator_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,

  CONSTRAINT fk_transactions_vendor
    FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 7. system_config — key-value system settings
-- ---------------------------------------------------------------------------
CREATE TABLE system_config (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  config_key    VARCHAR(50)    NOT NULL UNIQUE,
  config_value  VARCHAR(200)   NOT NULL,
  updated_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 8. audit_log — all system events
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          INT            AUTO_INCREMENT PRIMARY KEY,
  event       VARCHAR(100)   NOT NULL,
  detail      TEXT           NULL,
  username    VARCHAR(50)    NULL,
  type        ENUM('vend','login','logout','create','update','delete','reversal','system') DEFAULT 'system',
  ip_address  VARCHAR(45)    NULL,
  created_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_audit_log_username   (username),
  INDEX idx_audit_log_type       (type),
  INDEX idx_audit_log_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
